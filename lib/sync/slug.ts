/**
 * Stabile, eindeutige Slugs: Titel-Basis + ImmoScout-ID.
 * Beispiel: "Helle 3-Zimmer Wohnung" + 123456789 → "helle-3-zimmer-wohnung-123456789"
 */

const UMLAUT_MAP: Record<string, string> = {
  ä: "ae",
  ö: "oe",
  ü: "ue",
  ß: "ss",
};

const MAX_TITLE_PART = 60;

export function slugifyTitle(title: string): string {
  let s = title.toLowerCase();
  s = s.replace(/[äöüß]/g, (ch) => UMLAUT_MAP[ch] ?? ch);
  // Restliche Diakritika (é → e usw.) entfernen.
  s = s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  s = s
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (s.length > MAX_TITLE_PART) {
    s = s.slice(0, MAX_TITLE_PART).replace(/-+$/g, "");
    const lastDash = s.lastIndexOf("-");
    if (lastDash > MAX_TITLE_PART * 0.5) s = s.slice(0, lastDash);
  }
  return s;
}

export function buildListingSlug(title: string, is24Id: string): string {
  const idPart = is24Id.replace(/[^a-z0-9]/gi, "").toLowerCase() || "0";
  const base = slugifyTitle(title);
  return base ? `${base}-${idPart}` : `immobilie-${idPart}`;
}
