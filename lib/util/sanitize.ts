/**
 * Wandelt IS24-Freitexte in sicheres, einfaches HTML um.
 * Strategie: erst ALLES escapen (damit kann kein Script/iframe/Event-Handler
 * überleben), dann Zeilenumbrüche als Absätze/<br> ausgeben.
 */

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Entfernt HTML-Tags und normalisiert Whitespace → reiner Text. */
export function stripToPlainText(input: string): string {
  return input
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Freitext → sicheres HTML mit <p>/<br>; leerer Input → leerer String. */
export function textToSafeHtml(input: string): string {
  const normalized = input.replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "";
  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((p) => escapeHtml(p.trim()).replace(/\n/g, "<br>"))
    .filter((p) => p.length > 0);
  return paragraphs.map((p) => `<p>${p}</p>`).join("");
}

/** Kürzt reinen Text an Wortgrenze (für Kurzbeschreibungen). */
export function truncatePlainText(input: string, maxLength: number): string {
  const text = stripToPlainText(input);
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > maxLength * 0.6 ? lastSpace : maxLength).trimEnd()}…`;
}
