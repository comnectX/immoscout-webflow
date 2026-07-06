import { describe, expect, it } from "vitest";
import { SourceIncompleteError } from "@/lib/errors";
import type { ListingSource, SourceFetchResult } from "@/lib/is24/client";
import type { NormalizedListing } from "@/lib/is24/normalize";
import { createLogger } from "@/lib/log";
import { runSync, SyncOptions } from "@/lib/sync/engine";
import { computeListingHash } from "@/lib/sync/hash";
import type { ImageResolver } from "@/lib/webflow/assets";
import type {
  WebflowCollectionSchema,
  WebflowGateway,
  WebflowItem,
  WebflowItemUpdate,
  WebflowItemWrite,
} from "@/lib/webflow/client";

// ── Fakes ─────────────────────────────────────────────────────────────────────

const silentLogger = (() => {
  const logger = createLogger("test-run");
  return {
    ...logger,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => silentLogger,
  };
})();

const schema: WebflowCollectionSchema = {
  id: "col1",
  displayName: "Immobilien",
  fields: [
    { id: "f1", slug: "name", type: "PlainText" },
    { id: "f2", slug: "slug", type: "PlainText" },
    { id: "f3", slug: "is24-id", type: "PlainText" },
    { id: "f4", slug: "sync-hash", type: "PlainText" },
    { id: "f5", slug: "preis", type: "Number" },
  ],
};

class FakeWebflow implements WebflowGateway {
  createdCalls: WebflowItemWrite[][] = [];
  updatedCalls: WebflowItemUpdate[][] = [];
  publishedIds: string[] = [];
  unpublishedIds: string[] = [];
  private counter = 0;

  constructor(public items: WebflowItem[] = []) {}

  async getCollectionSchema() {
    return schema;
  }
  async listAllItems() {
    return this.items;
  }
  async createItems(items: WebflowItemWrite[]): Promise<WebflowItem[]> {
    this.createdCalls.push(items);
    return items.map((item) => ({
      id: `wf-${++this.counter}`,
      isDraft: item.isDraft ?? false,
      isArchived: item.isArchived ?? false,
      fieldData: item.fieldData,
    }));
  }
  async updateItems(items: WebflowItemUpdate[]) {
    this.updatedCalls.push(items);
  }
  async publishItems(itemIds: string[]) {
    this.publishedIds.push(...itemIds);
  }
  async unpublishItem(itemId: string) {
    this.unpublishedIds.push(itemId);
  }

  get writeCount(): number {
    return (
      this.createdCalls.length +
      this.updatedCalls.length +
      this.publishedIds.length +
      this.unpublishedIds.length
    );
  }
}

class FakeSource implements ListingSource {
  constructor(
    private readonly result: SourceFetchResult | Error,
  ) {}
  async fetchListings(): Promise<SourceFetchResult> {
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
  async fetchImage(): Promise<{ bytes: Uint8Array; contentType: string }> {
    return { bytes: new Uint8Array([1]), contentType: "image/jpeg" };
  }
}

const noopImages: ImageResolver = {
  resolve: async () => ({ mainImage: undefined, gallery: [], warnings: [] }),
};

const listing = (id: string, overrides: Partial<NormalizedListing> = {}): NormalizedListing => ({
  id,
  title: `Wohnung ${id}`,
  price: 1000,
  images: [],
  ...overrides,
});

const okSource = (listings: NormalizedListing[], failedIds: string[] = []): FakeSource =>
  new FakeSource({ listings, failedIds, complete: true, totalHits: listings.length + failedIds.length });

const existingItem = (
  is24Id: string | undefined,
  hash: string | undefined,
  id = `wf-existing-${is24Id ?? "manual"}`,
): WebflowItem => ({
  id,
  isDraft: false,
  isArchived: false,
  fieldData: {
    name: `Bestand ${is24Id ?? "manuell"}`,
    slug: `bestand-${is24Id ?? "manuell"}`,
    ...(is24Id ? { "is24-id": is24Id } : {}),
    ...(hash ? { "sync-hash": hash } : {}),
  },
});

const baseOptions: SyncOptions = {
  dryRun: false,
  syncImages: false,
  inactiveAction: "unpublish",
  maxConcurrency: 2,
  fieldMapOverride: null,
};

const run = (source: ListingSource, webflow: WebflowGateway, opts: Partial<SyncOptions> = {}) =>
  runSync(
    { source, webflow, imageResolver: noopImages, logger: silentLogger },
    { ...baseOptions, ...opts },
    "test-run",
  );

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runSync — Dry Run", () => {
  it("führt keinerlei Webflow-Schreiboperationen aus", async () => {
    const l1 = listing("1");
    const webflow = new FakeWebflow([
      existingItem("2", "veralteter-hash"),
      existingItem("3", "egal"),
    ]);
    const report = await run(okSource([l1, listing("2")]), webflow, { dryRun: true });

    expect(report.success).toBe(true);
    expect(report.dryRun).toBe(true);
    expect(webflow.writeCount).toBe(0);
    expect(report.createCount).toBe(1);
    expect(report.updateCount).toBe(1);
    expect(report.wouldUnpublish).toHaveLength(1);
    expect(report.wouldUnpublish[0]?.is24Id).toBe("3");
    expect(report.unpublishCount).toBe(0);
    expect(report.created[0]?.slug).toBe("wohnung-1-1");
  });
});

describe("runSync — Anlegen, Aktualisieren, Veröffentlichen", () => {
  it("legt neue Inserate staged an und veröffentlicht nur betroffene Items", async () => {
    const webflow = new FakeWebflow([]);
    const report = await run(okSource([listing("1")]), webflow);

    expect(report.success).toBe(true);
    expect(report.createCount).toBe(1);
    expect(webflow.createdCalls).toHaveLength(1);
    const created = webflow.createdCalls[0]?.[0];
    expect(created?.isDraft).toBe(false);
    expect(created?.isArchived).toBe(false);
    expect(created?.fieldData["is24-id"]).toBe("1");
    expect(typeof created?.fieldData["sync-hash"]).toBe("string");
    expect(created?.fieldData.slug).toBe("wohnung-1-1");
    expect(webflow.publishedIds).toHaveLength(1);
  });

  it("aktualisiert geänderte Inserate, ohne den Slug zu überschreiben", async () => {
    const l = listing("1", { price: 2222 });
    const webflow = new FakeWebflow([existingItem("1", "alter-hash")]);
    const report = await run(okSource([l]), webflow);

    expect(report.updateCount).toBe(1);
    expect(report.createCount).toBe(0);
    const update = webflow.updatedCalls[0]?.[0];
    expect(update?.id).toBe("wf-existing-1");
    expect(update?.fieldData.preis).toBe(2222);
    expect(Object.keys(update?.fieldData ?? {})).not.toContain("slug");
    expect(webflow.publishedIds).toEqual(["wf-existing-1"]);
  });
});

describe("runSync — Idempotenz und Duplikatschutz", () => {
  it("zweiter Lauf mit unveränderten Daten: keine Duplikate, keine Writes", async () => {
    const l = listing("1");
    const hash = await computeListingHash(l);
    const webflow = new FakeWebflow([existingItem("1", hash)]);
    const report = await run(okSource([l]), webflow);

    expect(report.success).toBe(true);
    expect(report.createCount).toBe(0);
    expect(report.updateCount).toBe(0);
    expect(report.unchangedCount).toBe(1);
    expect(webflow.writeCount).toBe(0);
  });

  it("erkennt bestehende Items über die is24-id — auch mehrere Läufe erzeugen nie Duplikate", async () => {
    const l = listing("1", { price: 3333 });
    const webflow = new FakeWebflow([existingItem("1", "veraltet")]);
    const report = await run(okSource([l]), webflow);
    expect(report.createCount).toBe(0);
    expect(report.updateCount).toBe(1);
  });

  it("warnt bei doppelten is24-ids in Webflow statt beide zu verändern", async () => {
    const l = listing("1");
    const hash = await computeListingHash(l);
    const webflow = new FakeWebflow([
      existingItem("1", hash, "wf-a"),
      existingItem("1", hash, "wf-b"),
    ]);
    const report = await run(okSource([l]), webflow);
    expect(report.warnings.some((w) => w.includes("Duplikat"))).toBe(true);
    expect(report.createCount).toBe(0);
  });

  it("reaktiviert ein zuvor unveröffentlichtes Item, wenn das Inserat zurückkehrt", async () => {
    const l = listing("1");
    const hash = await computeListingHash(l);
    const draftItem = { ...existingItem("1", hash), isDraft: true };
    const webflow = new FakeWebflow([draftItem]);
    const report = await run(okSource([l]), webflow);
    expect(report.updateCount).toBe(1);
    expect(webflow.updatedCalls[0]?.[0]?.isDraft).toBe(false);
  });
});

describe("runSync — Unpublishing & Sicherheitsregeln", () => {
  it("unveröffentlicht entfernte Inserate, löscht sie aber nicht", async () => {
    const webflow = new FakeWebflow([existingItem("99", "hash")]);
    const report = await run(okSource([]), webflow);

    expect(report.unpublishCount).toBe(1);
    expect(webflow.unpublishedIds).toEqual(["wf-existing-99"]);
    // Staged-Item bleibt erhalten und wird als Entwurf markiert.
    expect(webflow.updatedCalls.flat().some((u) => u.id === "wf-existing-99" && u.isDraft === true)).toBe(true);
  });

  it("fasst manuell erstellte Items ohne is24-id niemals an", async () => {
    const manual = existingItem(undefined, undefined, "wf-manual");
    const webflow = new FakeWebflow([manual]);
    const report = await run(okSource([]), webflow);

    expect(webflow.unpublishedIds).toEqual([]);
    expect(webflow.updatedCalls.flat().every((u) => u.id !== "wf-manual")).toBe(true);
    expect(report.unpublishCount).toBe(0);
  });

  it("bricht bei unvollständigem IS24-Abruf VOR allen Writes ab", async () => {
    const webflow = new FakeWebflow([existingItem("1", "hash")]);
    const source = new FakeSource(new SourceIncompleteError("Seite 2 nicht ladbar"));
    const report = await run(source, webflow);

    expect(report.success).toBe(false);
    expect(report.errorCount).toBeGreaterThan(0);
    expect(webflow.writeCount).toBe(0);
  });

  it("setzt Unpublishing aus, wenn einzelne Detail-Abrufe fehlschlagen", async () => {
    const l1 = listing("1");
    const webflow = new FakeWebflow([
      existingItem("1", "veraltet"),
      existingItem("2", "hash"), // Detail von "2" schlug fehl
      existingItem("3", "hash"), // "3" ist wirklich verschwunden
    ]);
    const report = await run(okSource([l1], ["2"]), webflow);

    // Sichere Writes passieren weiterhin …
    expect(report.updateCount).toBe(1);
    // … aber nichts wird unveröffentlicht — auch nicht das wirklich verschwundene Item.
    expect(webflow.unpublishedIds).toEqual([]);
    expect(report.unpublishCount).toBe(0);
    expect(report.wouldUnpublish.some((r) => r.is24Id === "3")).toBe(true);
    expect(report.warnings.some((w) => w.includes("Sicherheitsregel"))).toBe(true);
    expect(report.success).toBe(false); // Detail-Fehler wird als Fehler berichtet
  });

  it("INACTIVE_ACTION=ignore lässt verschwundene Inserate unangetastet", async () => {
    const webflow = new FakeWebflow([existingItem("99", "hash")]);
    const report = await run(okSource([]), webflow, { inactiveAction: "ignore" });

    expect(webflow.unpublishedIds).toEqual([]);
    expect(report.unpublishCount).toBe(0);
    expect(report.wouldUnpublish).toHaveLength(1);
  });
});
