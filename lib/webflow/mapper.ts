import type { NormalizedListing } from "@/lib/is24/normalize";
import { textToSafeHtml, truncatePlainText } from "@/lib/util/sanitize";
import type { ResolvedMapping } from "@/lib/webflow/schema";

export interface ImageRef {
  url: string;
  alt?: string;
}

export interface BuildFieldDataInput {
  listing: NormalizedListing;
  mapping: ResolvedMapping;
  syncHash: string;
  lastSyncedAt: string;
  mainImage?: ImageRef;
  gallery?: ImageRef[];
}

/** Wert aus dem normalisierten Modell für einen Mapping-Schlüssel. */
function sourceValue(key: string, input: BuildFieldDataInput): unknown {
  const l = input.listing;
  switch (key) {
    case "id":
      return l.id;
    case "syncHash":
      return input.syncHash;
    case "lastSyncedAt":
      return input.lastSyncedAt;
    case "mainImage":
      return input.mainImage;
    case "gallery":
      return input.gallery;
    case "street":
      return l.address?.street;
    case "houseNumber":
      return l.address?.houseNumber;
    case "zip":
      return l.address?.zip;
    case "city":
      return l.address?.city;
    case "region":
      return l.address?.region;
    case "country":
      return l.address?.country;
    case "latitude":
      return l.address?.latitude;
    case "longitude":
      return l.address?.longitude;
    case "shortDescription":
      return l.shortDescription ?? (l.description ? truncatePlainText(l.description, 180) : undefined);
    default:
      return (l as unknown as Record<string, unknown>)[key];
  }
}

const isEmpty = (v: unknown): boolean =>
  v === undefined ||
  v === null ||
  (typeof v === "string" && v.trim() === "") ||
  (typeof v === "number" && !Number.isFinite(v)) ||
  (Array.isArray(v) && v.length === 0);

/** Koerziert einen Wert auf den Webflow-Feldtyp; undefined = Feld auslassen. */
function coerceForFieldType(fieldType: string, value: unknown): unknown {
  switch (fieldType) {
    case "Number": {
      const n = typeof value === "number" ? value : Number.parseFloat(String(value));
      return Number.isFinite(n) ? n : undefined;
    }
    case "RichText":
      return typeof value === "string" ? textToSafeHtml(value) || undefined : undefined;
    case "DateTime": {
      const date = new Date(String(value));
      return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    }
    case "Image": {
      const img = value as ImageRef | undefined;
      return img?.url ? { url: img.url, alt: img.alt ?? "" } : undefined;
    }
    case "MultiImage": {
      const imgs = (value as ImageRef[] | undefined) ?? [];
      const valid = imgs.filter((i) => Boolean(i?.url)).map((i) => ({ url: i.url, alt: i.alt ?? "" }));
      return valid.length > 0 ? valid : undefined;
    }
    case "Link":
      return typeof value === "string" && /^https?:\/\//.test(value) ? value : undefined;
    case "Switch":
      return typeof value === "boolean" ? value : undefined;
    default:
      // PlainText, Option, Color, …: als String schreiben.
      if (typeof value === "object") return undefined;
      return String(value);
  }
}

/**
 * Baut das fieldData-Objekt für ein Webflow-Item.
 * Enthält AUSSCHLIESSLICH gemappte Felder — nicht gemappte, manuell
 * gepflegte Felder werden von PATCH-Updates nie berührt.
 * name wird immer gesetzt; slug setzt der Aufrufer nur bei Neuanlage.
 */
export function buildFieldData(input: BuildFieldDataInput): {
  fieldData: Record<string, unknown>;
  warnings: string[];
} {
  const fieldData: Record<string, unknown> = {};
  const warnings: string[] = [];

  for (const [key, field] of input.mapping.entries) {
    const raw = sourceValue(key, input);
    if (isEmpty(raw)) continue;
    const coerced = coerceForFieldType(field.type, raw);
    if (isEmpty(coerced)) {
      warnings.push(
        `Inserat ${input.listing.id}: Wert für "${field.slug}" (Typ ${field.type}) nicht konvertierbar — übersprungen`,
      );
      continue;
    }
    fieldData[field.slug] = coerced;
  }

  // name ist ein Webflow-Pflichtfeld und darf nie leer sein.
  fieldData.name = input.listing.title?.trim() || `Immobilie ${input.listing.id}`;

  return { fieldData, warnings };
}

/** Alt-Text aus Bildtitel bzw. Inseratstitel + Position. */
export function buildAltText(listingTitle: string, imageTitle: string | undefined, position: number): string {
  const base = imageTitle?.trim() || listingTitle.trim();
  return `${base} – Bild ${position + 1}`;
}
