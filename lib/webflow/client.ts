import { AppConfig } from "@/lib/config";
import { WebflowApiError, classifyHttpError } from "@/lib/errors";
import { fetchWithRetry, parseRetryAfterMs } from "@/lib/http";
import { Logger } from "@/lib/log";
import { chunk } from "@/lib/util/concurrency";

const API_BASE = "https://api.webflow.com/v2";
const BATCH_SIZE = 100;

export interface WebflowField {
  id: string;
  slug: string;
  displayName?: string;
  type: string;
  isRequired?: boolean;
}

export interface WebflowCollectionSchema {
  id: string;
  displayName?: string;
  slug?: string;
  fields: WebflowField[];
}

export interface WebflowItem {
  id: string;
  isDraft: boolean;
  isArchived: boolean;
  lastPublished?: string | null;
  fieldData: Record<string, unknown>;
}

export interface WebflowItemWrite {
  fieldData: Record<string, unknown>;
  isDraft?: boolean;
  isArchived?: boolean;
}

export interface WebflowItemUpdate extends WebflowItemWrite {
  id: string;
}

export interface WebflowAsset {
  id: string;
  hostedUrl?: string;
  originalFileName?: string;
  displayName?: string;
}

export interface WebflowGateway {
  getCollectionSchema(): Promise<WebflowCollectionSchema>;
  listAllItems(): Promise<WebflowItem[]>;
  createItems(items: WebflowItemWrite[]): Promise<WebflowItem[]>;
  updateItems(items: WebflowItemUpdate[]): Promise<void>;
  publishItems(itemIds: string[]): Promise<void>;
  unpublishItem(itemId: string): Promise<void>;
}

export class WebflowClient implements WebflowGateway {
  constructor(
    private readonly cfg: Pick<AppConfig, "webflowApiToken" | "webflowSiteId" | "webflowCollectionId">,
    private readonly logger: Logger,
  ) {}

  async request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const res = await fetchWithRetry(
      `${API_BASE}${path}`,
      {
        method: init?.method ?? "GET",
        headers: {
          Authorization: `Bearer ${this.cfg.webflowApiToken}`,
          Accept: "application/json",
          ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      },
      { logger: this.logger, label: `webflow ${init?.method ?? "GET"} ${path}` },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw classifyHttpError(
        "webflow",
        res.status,
        `Webflow-Request ${init?.method ?? "GET"} ${path} fehlgeschlagen mit HTTP ${res.status}: ${body.slice(0, 300)}`,
        parseRetryAfterMs(res),
      );
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new WebflowApiError(`Webflow-Antwort für ${path} ist kein gültiges JSON`, { cause: err });
    }
  }

  async getSite(): Promise<{ id: string; displayName?: string }> {
    return this.request(`/sites/${this.cfg.webflowSiteId}`);
  }

  async getCollectionSchema(): Promise<WebflowCollectionSchema> {
    const raw = await this.request<{
      id: string;
      displayName?: string;
      slug?: string;
      fields?: Array<{ id: string; slug?: string; displayName?: string; type?: string; isRequired?: boolean }>;
    }>(`/collections/${this.cfg.webflowCollectionId}`);
    return {
      id: raw.id,
      displayName: raw.displayName,
      slug: raw.slug,
      fields: (raw.fields ?? [])
        .filter((f) => typeof f.slug === "string" && f.slug.length > 0)
        .map((f) => ({
          id: f.id,
          slug: f.slug as string,
          displayName: f.displayName,
          type: f.type ?? "PlainText",
          isRequired: f.isRequired,
        })),
    };
  }

  /** Alle Staged-Items (inkl. Entwürfe) vollständig paginiert. */
  async listAllItems(): Promise<WebflowItem[]> {
    const items: WebflowItem[] = [];
    let offset = 0;
    while (true) {
      const page = await this.request<{
        items?: WebflowItem[];
        pagination?: { total?: number; offset?: number; limit?: number };
      }>(`/collections/${this.cfg.webflowCollectionId}/items?limit=${BATCH_SIZE}&offset=${offset}`);
      const pageItems = page.items ?? [];
      items.push(...pageItems);
      const total = page.pagination?.total ?? items.length;
      offset += pageItems.length;
      if (offset >= total || pageItems.length === 0) break;
    }
    return items;
  }

  /** Staged-Create in Batches à 100. */
  async createItems(items: WebflowItemWrite[]): Promise<WebflowItem[]> {
    const created: WebflowItem[] = [];
    for (const batch of chunk(items, BATCH_SIZE)) {
      const res = await this.request<{ items?: WebflowItem[] } | WebflowItem>(
        `/collections/${this.cfg.webflowCollectionId}/items`,
        { method: "POST", body: { items: batch } },
      );
      if (res && typeof res === "object" && "items" in res && Array.isArray(res.items)) {
        created.push(...res.items);
      } else if (res && typeof res === "object" && "id" in res) {
        created.push(res as WebflowItem);
      }
    }
    return created;
  }

  /** Staged-Update in Batches à 100. */
  async updateItems(items: WebflowItemUpdate[]): Promise<void> {
    for (const batch of chunk(items, BATCH_SIZE)) {
      await this.request(`/collections/${this.cfg.webflowCollectionId}/items`, {
        method: "PATCH",
        body: { items: batch },
      });
    }
  }

  /** Veröffentlicht ausschließlich die übergebenen Items (kein Site-Publish). */
  async publishItems(itemIds: string[]): Promise<void> {
    for (const batch of chunk(itemIds, BATCH_SIZE)) {
      await this.request(`/collections/${this.cfg.webflowCollectionId}/items/publish`, {
        method: "POST",
        body: { itemIds: batch },
      });
    }
  }

  /**
   * Entfernt die Live-Version eines Items; das Staged-Item bleibt erhalten.
   * 404/409 (nie veröffentlicht) wird toleriert.
   */
  async unpublishItem(itemId: string): Promise<void> {
    try {
      await this.request(`/collections/${this.cfg.webflowCollectionId}/items/${itemId}/live`, {
        method: "DELETE",
      });
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404 || status === 409) return;
      throw err;
    }
  }

  // ── Assets ────────────────────────────────────────────────────────────────

  async listAllAssets(): Promise<WebflowAsset[]> {
    const assets: WebflowAsset[] = [];
    let offset = 0;
    while (true) {
      const page = await this.request<{
        assets?: WebflowAsset[];
        pagination?: { total?: number };
      }>(`/sites/${this.cfg.webflowSiteId}/assets?limit=${BATCH_SIZE}&offset=${offset}`);
      const pageAssets = page.assets ?? [];
      assets.push(...pageAssets);
      const total = page.pagination?.total ?? assets.length;
      offset += pageAssets.length;
      if (offset >= total || pageAssets.length === 0) break;
    }
    return assets;
  }

  async createAssetMetadata(fileName: string, fileHashMd5: string): Promise<{
    id: string;
    uploadUrl: string;
    uploadDetails: Record<string, string>;
    hostedUrl?: string;
  }> {
    const res = await this.request<{
      id: string;
      uploadUrl?: string;
      uploadDetails?: Record<string, string>;
      hostedUrl?: string;
      assetUrl?: string;
    }>(`/sites/${this.cfg.webflowSiteId}/assets`, {
      method: "POST",
      body: { fileName, fileHash: fileHashMd5 },
    });
    if (!res.uploadUrl || !res.uploadDetails) {
      throw new WebflowApiError("Webflow-Asset-Erstellung lieferte keine Upload-Details");
    }
    return {
      id: res.id,
      uploadUrl: res.uploadUrl,
      uploadDetails: res.uploadDetails,
      hostedUrl: res.hostedUrl ?? res.assetUrl,
    };
  }

  /** S3-Upload mit den von Webflow gelieferten Formularfeldern. */
  async uploadAssetBinary(
    uploadUrl: string,
    uploadDetails: Record<string, string>,
    bytes: Uint8Array,
    contentType: string,
    fileName: string,
  ): Promise<void> {
    const form = new FormData();
    for (const [k, v] of Object.entries(uploadDetails)) form.append(k, v);
    form.append("file", new Blob([bytes.buffer as ArrayBuffer], { type: contentType }), fileName);
    const res = await fetchWithRetry(
      uploadUrl,
      { method: "POST", body: form },
      { logger: this.logger, label: "webflow asset upload" },
    );
    if (!res.ok && res.status !== 201 && res.status !== 204) {
      const body = await res.text().catch(() => "");
      throw new WebflowApiError(`Asset-Binär-Upload fehlgeschlagen mit HTTP ${res.status}: ${body.slice(0, 200)}`, {
        status: res.status,
      });
    }
  }
}
