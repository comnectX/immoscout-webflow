import type { NormalizedListing } from "@/lib/is24/normalize";

/** Deterministische Serialisierung: Objekt-Schlüssel werden rekursiv sortiert. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Stabiler Inhalts-Hash eines Inserats über alle synchronisierten Felder.
 * Bewusst NICHT enthalten: last-synced-at (volatil) und Webflow-interne Daten.
 */
export async function computeListingHash(listing: NormalizedListing): Promise<string> {
  const hashInput = {
    ...listing,
    images: listing.images.map((img) => ({
      id: img.id,
      order: img.order,
      title: img.title ?? null,
    })),
  };
  return sha256Hex(stableStringify(hashInput));
}
