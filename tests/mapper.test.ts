import { describe, expect, it } from "vitest";
import type { NormalizedListing } from "@/lib/is24/normalize";
import { MappingError } from "@/lib/errors";
import { buildFieldData } from "@/lib/webflow/mapper";
import { resolveFieldMapping } from "@/lib/webflow/schema";
import type { WebflowCollectionSchema } from "@/lib/webflow/client";

const fullSchema: WebflowCollectionSchema = {
  id: "col1",
  displayName: "Immobilien",
  fields: [
    { id: "f1", slug: "name", type: "PlainText" },
    { id: "f2", slug: "slug", type: "PlainText" },
    { id: "f3", slug: "is24-id", type: "PlainText" },
    { id: "f4", slug: "sync-hash", type: "PlainText" },
    { id: "f5", slug: "preis", type: "Number" },
    { id: "f6", slug: "beschreibung", type: "RichText" },
    { id: "f7", slug: "hauptbild", type: "Image" },
    { id: "f8", slug: "bilder", type: "MultiImage" },
    { id: "f9", slug: "expose-url", type: "Link" },
    { id: "f10", slug: "last-synced-at", type: "DateTime" },
    { id: "f11", slug: "ort", type: "PlainText" },
    { id: "f12", slug: "zimmer", type: "Number" },
  ],
};

const listing: NormalizedListing = {
  id: "123456789",
  title: "Helle 3-Zimmer Wohnung",
  price: 349000,
  currency: "EUR",
  rooms: 3,
  description: "Zeile 1\n\nZeile 2 mit <script>alert(1)</script>",
  address: { city: "Köln" },
  exposeUrl: "https://www.immobilienscout24.de/expose/123456789",
  images: [],
};

describe("resolveFieldMapping", () => {
  it("mappt vorhandene Felder und warnt für fehlende optionale Felder", () => {
    const mapping = resolveFieldMapping(fullSchema, null);
    expect(mapping.idSlug).toBe("is24-id");
    expect(mapping.syncHashSlug).toBe("sync-hash");
    expect(mapping.entries.has("price")).toBe(true);
    expect(mapping.entries.has("plotArea")).toBe(false); // grundstuecksflaeche existiert nicht
    expect(mapping.warnings.some((w) => w.includes("grundstuecksflaeche"))).toBe(true);
  });

  it("bricht ab, wenn das is24-id-Feld fehlt", () => {
    const schema: WebflowCollectionSchema = {
      id: "col2",
      fields: [
        { id: "a", slug: "name", type: "PlainText" },
        { id: "b", slug: "slug", type: "PlainText" },
      ],
    };
    expect(() => resolveFieldMapping(schema, null)).toThrow(MappingError);
    expect(() => resolveFieldMapping(schema, null)).toThrow(/is24-id/);
  });

  it("respektiert WEBFLOW_FIELD_MAP_JSON-Overrides", () => {
    const schema: WebflowCollectionSchema = {
      id: "col3",
      fields: [
        { id: "a", slug: "name", type: "PlainText" },
        { id: "b", slug: "slug", type: "PlainText" },
        { id: "c", slug: "scout-id", type: "PlainText" },
      ],
    };
    const mapping = resolveFieldMapping(schema, { id: "scout-id" });
    expect(mapping.idSlug).toBe("scout-id");
  });
});

describe("buildFieldData", () => {
  const mapping = resolveFieldMapping(fullSchema, null);
  const build = (l: NormalizedListing) =>
    buildFieldData({
      listing: l,
      mapping,
      syncHash: "abc123",
      lastSyncedAt: "2026-07-06T12:00:00.000Z",
      mainImage: { url: "https://assets.example/1.jpg", alt: "Bild 1" },
      gallery: [{ url: "https://assets.example/1.jpg", alt: "Bild 1" }],
    });

  it("schreibt nur gemappte, vorhandene Felder mit korrekten Typen", () => {
    const { fieldData } = build(listing);
    expect(fieldData["is24-id"]).toBe("123456789");
    expect(fieldData["sync-hash"]).toBe("abc123");
    expect(fieldData.name).toBe("Helle 3-Zimmer Wohnung");
    expect(fieldData.preis).toBe(349000);
    expect(fieldData.zimmer).toBe(3);
    expect(fieldData.ort).toBe("Köln");
    expect(fieldData["expose-url"]).toBe("https://www.immobilienscout24.de/expose/123456789");
    expect(fieldData["last-synced-at"]).toBe("2026-07-06T12:00:00.000Z");
    expect(fieldData.hauptbild).toEqual({ url: "https://assets.example/1.jpg", alt: "Bild 1" });
    // Nicht gemappte Felder tauchen nicht auf → manuelle Felder bleiben unberührt.
    expect(Object.keys(fieldData)).not.toContain("waehrung");
    expect(Object.keys(fieldData)).not.toContain("slug");
  });

  it("sanitisiert Rich-Text (kein aktives HTML, Absätze erhalten)", () => {
    const { fieldData } = build(listing);
    const html = fieldData.beschreibung as string;
    expect(html).toContain("<p>Zeile 1</p>");
    expect(html).toContain("<p>Zeile 2");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("lässt leere/ungültige Werte vollständig aus", () => {
    const sparse: NormalizedListing = {
      id: "1",
      title: "Nur Titel",
      price: Number.NaN,
      description: "   ",
      images: [],
    };
    const { fieldData } = buildFieldData({
      listing: sparse,
      mapping,
      syncHash: "h",
      lastSyncedAt: "2026-07-06T12:00:00.000Z",
    });
    expect(Object.keys(fieldData)).not.toContain("preis");
    expect(Object.keys(fieldData)).not.toContain("beschreibung");
    expect(Object.keys(fieldData)).not.toContain("hauptbild");
    expect(fieldData.name).toBe("Nur Titel");
  });

  it("setzt einen Fallback-Namen bei leerem Titel", () => {
    const { fieldData } = buildFieldData({
      listing: { id: "77", title: "  ", images: [] },
      mapping,
      syncHash: "h",
      lastSyncedAt: "2026-07-06T12:00:00.000Z",
    });
    expect(fieldData.name).toBe("Immobilie 77");
  });
});
