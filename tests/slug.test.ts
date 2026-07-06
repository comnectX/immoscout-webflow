import { describe, expect, it } from "vitest";
import { buildListingSlug, slugifyTitle } from "@/lib/sync/slug";

describe("slugifyTitle", () => {
  it("ersetzt deutsche Umlaute sinnvoll", () => {
    expect(slugifyTitle("Schöne Wohnung in Müllheim")).toBe("schoene-wohnung-in-muellheim");
    expect(slugifyTitle("Größe zählt: Häuser & Gärten")).toBe("groesse-zaehlt-haeuser-gaerten");
    expect(slugifyTitle("Straße mit ß")).toBe("strasse-mit-ss");
  });

  it("entfernt Sonderzeichen und weitere Diakritika", () => {
    expect(slugifyTitle("Café Résidence — Nr. 5!")).toBe("cafe-residence-nr-5");
    expect(slugifyTitle("100 m² / 3,5 Zi.")).toBe("100-m2-3-5-zi");
  });

  it("kürzt überlange Titel an Wortgrenzen", () => {
    const long = "sehr ".repeat(40) + "lange wohnungsbeschreibung";
    const slug = slugifyTitle(long);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-")).toBe(false);
  });
});

describe("buildListingSlug", () => {
  it("hängt die ImmoScout-ID an (Beispiel aus der Spezifikation)", () => {
    expect(buildListingSlug("Helle 3-Zimmer Wohnung", "123456789")).toBe(
      "helle-3-zimmer-wohnung-123456789",
    );
  });

  it("ist deterministisch und eindeutig pro ID", () => {
    const a = buildListingSlug("Gleicher Titel", "111");
    const b = buildListingSlug("Gleicher Titel", "222");
    expect(a).not.toBe(b);
    expect(a).toBe(buildListingSlug("Gleicher Titel", "111"));
  });

  it("liefert auch bei leerem/kaputtem Titel einen gültigen Slug", () => {
    expect(buildListingSlug("!!!", "987")).toBe("immobilie-987");
    expect(buildListingSlug("", "987")).toBe("immobilie-987");
  });
});
