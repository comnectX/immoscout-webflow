import { MappingError } from "@/lib/errors";
import type { WebflowCollectionSchema, WebflowField } from "@/lib/webflow/client";

/** Interner Modell-Schlüssel → Webflow-Feld-Slug. */
export type FieldMap = Record<string, string>;

/**
 * Dokumentiertes Standard-Mapping. Kann per WEBFLOW_FIELD_MAP_JSON
 * (partiell) überschrieben werden.
 */
export const DEFAULT_FIELD_MAP: FieldMap = {
  id: "is24-id",
  externalId: "external-id",
  syncHash: "sync-hash",
  title: "name",
  status: "status",
  propertyType: "objektart",
  marketingType: "vermarktungsart",
  price: "preis",
  currency: "waehrung",
  livingSpace: "wohnflaeche",
  usableSpace: "nutzflaeche",
  plotArea: "grundstuecksflaeche",
  rooms: "zimmer",
  bedrooms: "schlafzimmer",
  bathrooms: "badezimmer",
  floor: "etage",
  constructionYear: "baujahr",
  street: "strasse",
  houseNumber: "hausnummer",
  zip: "plz",
  city: "ort",
  region: "region",
  country: "land",
  latitude: "latitude",
  longitude: "longitude",
  shortDescription: "kurzbeschreibung",
  description: "beschreibung",
  furnishing: "ausstattung",
  locationDescription: "lage",
  energyCertificate: "energieausweis",
  mainImage: "hauptbild",
  gallery: "bilder",
  exposeUrl: "expose-url",
  modifiedAt: "is24-modified-at",
  lastSyncedAt: "last-synced-at",
};

export interface ResolvedMapping {
  /** Nur Einträge, deren Ziel-Feld in der Collection existiert. */
  entries: Map<string, WebflowField>;
  idSlug: string;
  syncHashSlug?: string;
  warnings: string[];
}

/**
 * Gleicht das konfigurierte Mapping mit dem echten Collection-Schema ab.
 *  - is24-id-Feld, name und slug fehlen → MappingError (Abbruch VOR Writes)
 *  - optionales Feld fehlt → Warnung, Feld wird übersprungen
 */
export function resolveFieldMapping(
  schema: WebflowCollectionSchema,
  override: FieldMap | null,
): ResolvedMapping {
  const fieldMap: FieldMap = { ...DEFAULT_FIELD_MAP, ...(override ?? {}) };
  const bySlug = new Map(schema.fields.map((f) => [f.slug, f]));
  const warnings: string[] = [];
  const entries = new Map<string, WebflowField>();

  const idSlug = fieldMap.id ?? "is24-id";
  const missingRequired: string[] = [];
  if (!bySlug.has(idSlug)) {
    missingRequired.push(
      `Pflichtfeld "${idSlug}" (ImmoScout-ID) fehlt in der Collection — bitte als Plain-Text-Feld anlegen`,
    );
  }
  if (!bySlug.has("name")) missingRequired.push('Pflichtfeld "name" fehlt in der Collection');
  if (!bySlug.has("slug")) missingRequired.push('Pflichtfeld "slug" fehlt in der Collection');
  if (missingRequired.length > 0) {
    throw new MappingError(
      `Collection "${schema.displayName ?? schema.id}" ist nicht kompatibel: ${missingRequired.join("; ")}`,
      { missing: missingRequired, availableSlugs: schema.fields.map((f) => f.slug) },
    );
  }

  for (const [key, slug] of Object.entries(fieldMap)) {
    const field = bySlug.get(slug);
    if (!field) {
      warnings.push(
        `Optionales Feld "${slug}" (Mapping-Schlüssel "${key}") existiert nicht in der Collection und wird übersprungen`,
      );
      continue;
    }
    entries.set(key, field);
  }

  const syncHashField = entries.get("syncHash");
  if (!syncHashField) {
    warnings.push(
      'Feld "sync-hash" fehlt — Änderungserkennung ist eingeschränkt, jedes Inserat wird bei jedem Lauf aktualisiert',
    );
  }

  return {
    entries,
    idSlug,
    syncHashSlug: syncHashField?.slug,
    warnings,
  };
}
