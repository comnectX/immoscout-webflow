import { describe, expect, it } from "vitest";
import type { NormalizedListing } from "@/lib/is24/normalize";
import { computeListingHash, stableStringify } from "@/lib/sync/hash";

const baseListing: NormalizedListing = {
  id: "123",
  title: "Testwohnung",
  price: 1000,
  currency: "EUR",
  address: { city: "Köln", zip: "50667" },
  images: [
    { id: "a", url: "https://x/a.jpg", order: 0 },
    { id: "b", url: "https://x/b.jpg", order: 1 },
  ],
};

describe("stableStringify", () => {
  it("ist unabhängig von der Schlüssel-Reihenfolge", () => {
    expect(stableStringify({ a: 1, b: { c: 2, d: 3 } })).toBe(
      stableStringify({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });

  it("lässt undefined-Werte aus", () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });
});

describe("computeListingHash", () => {
  it("ist deterministisch", async () => {
    const h1 = await computeListingHash(baseListing);
    const h2 = await computeListingHash(JSON.parse(JSON.stringify(baseListing)) as NormalizedListing);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ändert sich bei geänderten Feldwerten", async () => {
    const h1 = await computeListingHash(baseListing);
    const h2 = await computeListingHash({ ...baseListing, price: 1100 });
    expect(h1).not.toBe(h2);
  });

  it("ändert sich bei geänderter Bild-Reihenfolge, aber nicht bei URL-Rotation", async () => {
    const h1 = await computeListingHash(baseListing);
    const reordered = {
      ...baseListing,
      images: [
        { id: "b", url: "https://x/b.jpg", order: 0 },
        { id: "a", url: "https://x/a.jpg", order: 1 },
      ],
    };
    const rotatedUrls = {
      ...baseListing,
      images: baseListing.images.map((img) => ({
        ...img,
        url: `${img.url}?signature=neu`, // IS24-CDN-URLs können variieren
      })),
    };
    expect(await computeListingHash(reordered)).not.toBe(h1);
    expect(await computeListingHash(rotatedUrls)).toBe(h1);
  });
});
