import { AppConfig } from "@/lib/config";
import {
  AuthenticationError,
  Is24ApiError,
  PermissionError,
  RateLimitError,
  SourceIncompleteError,
  classifyHttpError,
  errorMessage,
} from "@/lib/errors";
import { fetchWithRetry, parseRetryAfterMs } from "@/lib/http";
import { Logger } from "@/lib/log";
import { pMap } from "@/lib/util/concurrency";
import {
  NormalizedListing,
  normalizeListing,
  parseRealEstateDetail,
  parseRealEstateListPage,
} from "@/lib/is24/normalize";
import { OAuthCredentials, signOAuthRequest } from "@/lib/is24/oauth";

const PAGE_SIZE = 100;
const MAX_PAGES = 200; // Sicherheitsgrenze gegen Endlos-Pagination

export interface SourceFetchResult {
  listings: NormalizedListing[];
  /** IDs, deren Detail-/Anhang-Abruf fehlschlug → Unpublishing wird gesperrt. */
  failedIds: string[];
  /** true nur, wenn alle Listen-Seiten nachweislich vollständig geladen wurden. */
  complete: boolean;
  totalHits: number;
}

export interface ListingSource {
  fetchListings(opts: { includeAttachments: boolean; concurrency: number }): Promise<SourceFetchResult>;
  fetchImage(url: string): Promise<{ bytes: Uint8Array; contentType: string }>;
}

export class Is24Client implements ListingSource {
  private readonly credentials: OAuthCredentials;

  constructor(
    private readonly cfg: Pick<
      AppConfig,
      | "is24ConsumerKey"
      | "is24ConsumerSecret"
      | "is24AccessToken"
      | "is24AccessTokenSecret"
      | "is24Username"
      | "is24BaseUrl"
      | "is24PublishChannel"
    >,
    private readonly logger: Logger,
  ) {
    this.credentials = {
      consumerKey: cfg.is24ConsumerKey,
      consumerSecret: cfg.is24ConsumerSecret,
      accessToken: cfg.is24AccessToken,
      accessTokenSecret: cfg.is24AccessTokenSecret,
    };
  }

  private url(path: string, params?: Record<string, string>): string {
    const url = new URL(`${this.cfg.is24BaseUrl}${path}`);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, v);
    return url.toString();
  }

  private async requestJson(path: string, params?: Record<string, string>): Promise<unknown> {
    const url = this.url(path, params);
    const { authorizationHeader } = await signOAuthRequest({
      method: "GET",
      url,
      credentials: this.credentials,
    });
    const res = await fetchWithRetry(
      url,
      {
        method: "GET",
        headers: {
          Authorization: authorizationHeader,
          Accept: "application/json",
        },
      },
      { logger: this.logger, label: `is24 GET ${path}` },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw classifyHttpError(
        "is24",
        res.status,
        `IS24-Request ${path} fehlgeschlagen mit HTTP ${res.status}: ${body.slice(0, 300)}`,
        parseRetryAfterMs(res),
      );
    }
    try {
      return await res.json();
    } catch (err) {
      throw new Is24ApiError(`IS24-Antwort für ${path} ist kein gültiges JSON`, { cause: err });
    }
  }

  private get userPath(): string {
    return `/offer/v1.0/user/${encodeURIComponent(this.cfg.is24Username)}/realestate`;
  }

  /**
   * Lädt ALLE Inserate des konfigurierten Publish-Channels, vollständig
   * paginiert. Schlägt eine Seite fehl oder passt die Seitenzahl nicht,
   * wird SourceIncompleteError geworfen — der Sync darf dann nichts
   * unveröffentlichen.
   */
  async listAllRealEstates(): Promise<{
    elements: Array<{ id: string; typeName: string; raw: Record<string, unknown> }>;
    totalHits: number;
  }> {
    const elements: Array<{ id: string; typeName: string; raw: Record<string, unknown> }> = [];
    let expectedPages = 1;
    let totalHits = 0;

    for (let page = 1; page <= Math.min(expectedPages, MAX_PAGES); page++) {
      let json: unknown;
      try {
        json = await this.requestJson(this.userPath, {
          publishchannel: this.cfg.is24PublishChannel.toUpperCase(),
          pagesize: String(PAGE_SIZE),
          pagenumber: String(page),
        });
      } catch (err) {
        if (
          err instanceof AuthenticationError ||
          err instanceof PermissionError ||
          err instanceof RateLimitError
        ) {
          throw err;
        }
        throw new SourceIncompleteError(
          `IS24-Listen-Seite ${page}/${expectedPages} konnte nicht geladen werden: ${errorMessage(err)}`,
          { cause: err },
        );
      }

      let parsed: ReturnType<typeof parseRealEstateListPage>;
      try {
        parsed = parseRealEstateListPage(json);
      } catch (err) {
        throw new SourceIncompleteError(
          `IS24-Listen-Seite ${page} konnte nicht geparst werden: ${errorMessage(err)}`,
          { cause: err },
        );
      }

      expectedPages = Math.max(1, parsed.numberOfPages);
      totalHits = parsed.totalHits;
      elements.push(...parsed.elements);
      this.logger.info(`IS24-Seite ${page}/${expectedPages} geladen`, {
        elementsOnPage: parsed.elements.length,
        totalHits,
      });

      if (page >= expectedPages) break;
    }

    if (expectedPages > MAX_PAGES) {
      throw new SourceIncompleteError(
        `IS24 meldet ${expectedPages} Seiten — über der Sicherheitsgrenze von ${MAX_PAGES}`,
      );
    }
    if (totalHits > 0 && elements.length < totalHits) {
      throw new SourceIncompleteError(
        `IS24-Abruf unvollständig: ${elements.length} von ${totalHits} Inseraten geladen`,
      );
    }

    return { elements, totalHits: totalHits || elements.length };
  }

  async getRealEstateDetail(id: string): Promise<{ typeName: string; root: Record<string, unknown> }> {
    const json = await this.requestJson(`${this.userPath}/${encodeURIComponent(id)}`);
    return parseRealEstateDetail(json);
  }

  async getAttachments(id: string): Promise<unknown> {
    return this.requestJson(`${this.userPath}/${encodeURIComponent(id)}/attachment`);
  }

  async fetchListings(opts: {
    includeAttachments: boolean;
    concurrency: number;
  }): Promise<SourceFetchResult> {
    const { elements, totalHits } = await this.listAllRealEstates();

    const failedIds: string[] = [];
    const listings = (
      await pMap(
        elements,
        async (element) => {
          try {
            const detail = await this.getRealEstateDetail(element.id);
            const attachments = opts.includeAttachments
              ? await this.getAttachments(element.id)
              : undefined;
            return normalizeListing(detail.typeName, detail.root, attachments, element.raw);
          } catch (err) {
            // Authentifizierungs-/Berechtigungsfehler betreffen den ganzen
            // Abruf, nicht nur ein Inserat → sofort abbrechen.
            if (err instanceof AuthenticationError || err instanceof PermissionError) throw err;
            failedIds.push(element.id);
            this.logger.error(`Detail-Abruf für Inserat ${element.id} fehlgeschlagen`, {
              error: errorMessage(err),
            });
            return null;
          }
        },
        opts.concurrency,
      )
    ).filter((l): l is NormalizedListing => l !== null);

    return { listings, failedIds, complete: true, totalHits };
  }

  /**
   * Lädt ein Bild: zuerst öffentlich, bei 401/403 erneut mit OAuth-Signatur.
   */
  async fetchImage(url: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    let res = await fetchWithRetry(url, { method: "GET" }, { logger: this.logger, label: "is24 image" });
    if (res.status === 401 || res.status === 403) {
      const { authorizationHeader } = await signOAuthRequest({
        method: "GET",
        url,
        credentials: this.credentials,
      });
      res = await fetchWithRetry(
        url,
        { method: "GET", headers: { Authorization: authorizationHeader } },
        { logger: this.logger, label: "is24 image (oauth)" },
      );
    }
    if (!res.ok) {
      throw new Is24ApiError(`Bild-Download fehlgeschlagen mit HTTP ${res.status}`, {
        status: res.status,
      });
    }
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes, contentType };
  }
}
