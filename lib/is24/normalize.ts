/**
 * Normalisierungsschicht: wandelt die XML-artigen, namensraumbehafteten
 * IS24-JSON-Strukturen aller Immobilientypen in ein gemeinsames Modell um.
 *
 * IS24-JSON-Eigenheiten, die hier behandelt werden:
 *  - Schlüssel mit Namespace: "realestates.realEstates", "common.attachments"
 *  - Attribut-Schlüssel: "@id", "@xsi.type", "@href", "@modification"
 *  - Text-Wrapper: { "#text": "..." } bzw. { "@value": ... }
 *  - Einzelobjekt statt Array bei genau einem Element
 *  - leere Strings / fehlende Felder je nach Immobilientyp
 */

export interface NormalizedListing {
  id: string;
  externalId?: string;
  title: string;
  propertyType?: string;
  marketingType?: string;
  status?: string;
  price?: number;
  currency?: string;
  livingSpace?: number;
  usableSpace?: number;
  plotArea?: number;
  rooms?: number;
  bedrooms?: number;
  bathrooms?: number;
  floor?: number;
  constructionYear?: number;
  address?: {
    street?: string;
    houseNumber?: string;
    zip?: string;
    city?: string;
    region?: string;
    country?: string;
    latitude?: number;
    longitude?: number;
  };
  shortDescription?: string;
  description?: string;
  furnishing?: string;
  locationDescription?: string;
  energyCertificate?: string;
  exposeUrl?: string;
  modifiedAt?: string;
  images: NormalizedImage[];
}

export interface NormalizedImage {
  id: string;
  url?: string;
  title?: string;
  mimeType?: string;
  order: number;
}

type JsonObject = Record<string, unknown>;

const isObject = (v: unknown): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** "realestates.realEstates" → "realEstates", "@xsi.type" → "type", "@id" → "id" */
export function stripNamespace(key: string): string {
  let k = key.startsWith("@") ? key.slice(1) : key;
  const dot = k.lastIndexOf(".");
  if (dot >= 0) k = k.slice(dot + 1);
  const colon = k.lastIndexOf(":");
  if (colon >= 0) k = k.slice(colon + 1);
  return k;
}

/** { "#text": x } / { "@value": x } → x */
function unwrap(value: unknown): unknown {
  if (isObject(value)) {
    if ("#text" in value) return value["#text"];
    if ("@value" in value && Object.keys(value).length === 1) return value["@value"];
  }
  return value;
}

/** Findet einen Wert per lokalem Namen, unabhängig von Namespace-Präfixen. */
export function getVal(obj: unknown, name: string): unknown {
  if (!isObject(obj)) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(obj)) {
    if (stripNamespace(k).toLowerCase() === lower) return unwrap(v);
  }
  return undefined;
}

export function getPath(obj: unknown, ...names: string[]): unknown {
  let current: unknown = obj;
  for (const name of names) {
    current = getVal(current, name);
    if (current === undefined) return undefined;
  }
  return current;
}

export function asArray<T = unknown>(value: unknown): T[] {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]) as T[];
}

export function toNum(value: unknown): number | undefined {
  const v = unwrap(value);
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number.parseFloat(v.replace(",", "."));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function toStr(value: unknown): string | undefined {
  const v = unwrap(value);
  if (typeof v === "string") {
    const s = v.trim();
    return s === "" ? undefined : s;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return undefined;
}

/** "realestates:ApartmentBuy" / "realestate.apartmentBuy" → "apartmentBuy" */
export function extractTypeName(raw: string): string {
  const name = stripNamespace(raw);
  return name.charAt(0).toLowerCase() + name.slice(1);
}

const PROPERTY_TYPE_DE: Record<string, string> = {
  apartment: "Wohnung",
  house: "Haus",
  garage: "Garage / Stellplatz",
  livingsite: "Wohngrundstück",
  livingbuysite: "Wohngrundstück",
  livingrentsite: "Wohngrundstück",
  tradesite: "Gewerbegrundstück",
  office: "Büro / Praxis",
  store: "Einzelhandel",
  industry: "Halle / Produktion",
  gastronomy: "Gastronomie / Hotel",
  specialpurpose: "Spezialgewerbe",
  investment: "Anlageobjekt",
  shorttermaccommodation: "Wohnen auf Zeit",
  flatsharedroom: "WG-Zimmer",
  flatshareroom: "WG-Zimmer",
  seniorcare: "Pflegeimmobilie",
  assistedliving: "Betreutes Wohnen",
  compulsoryauction: "Zwangsversteigerung",
  housetype: "Haus (Typenhaus)",
};

function derivePropertyAndMarketingType(typeName: string): {
  propertyType?: string;
  marketingType?: string;
} {
  const lower = typeName.toLowerCase();
  let marketingType: string | undefined;
  let base = lower;
  if (lower.endsWith("buy")) {
    marketingType = "Kauf";
    base = lower.slice(0, -3);
  } else if (lower.endsWith("rent")) {
    marketingType = "Miete";
    base = lower.slice(0, -4);
  }
  // livingBuySite/livingRentSite: Suffix steht in der Mitte.
  if (lower === "livingbuysite") {
    marketingType = "Kauf";
    base = "livingsite";
  } else if (lower === "livingrentsite") {
    marketingType = "Miete";
    base = "livingsite";
  }
  return { propertyType: PROPERTY_TYPE_DE[base] ?? PROPERTY_TYPE_DE[lower], marketingType };
}

const MARKETING_TYPE_DE: Record<string, string> = {
  PURCHASE: "Kauf",
  RENT: "Miete",
  PURCHASE_PER_SQM: "Kauf",
  RENT_PER_SQM: "Miete",
  LEASE: "Pacht",
  LEASEHOLD: "Erbpacht",
  BUDGET_RENT: "Miete",
};

function buildEnergyCertificate(estate: JsonObject): string | undefined {
  const parts: string[] = [];
  const cert = getVal(estate, "energyCertificate");
  const availability = toStr(getVal(cert, "energyCertificateAvailability"));
  if (availability === "AVAILABLE") parts.push("Energieausweis vorhanden");
  else if (availability === "NOT_AVAILABLE_YET") parts.push("Energieausweis noch nicht vorhanden");
  else if (availability === "NOT_REQUIRED") parts.push("Energieausweis nicht erforderlich");

  const ratingType = toStr(getVal(estate, "buildingEnergyRatingType"));
  if (ratingType === "ENERGY_CONSUMPTION") parts.push("Verbrauchsausweis");
  else if (ratingType === "ENERGY_REQUIRED") parts.push("Bedarfsausweis");

  const thermal = toNum(getVal(estate, "thermalCharacteristic"));
  if (thermal !== undefined) parts.push(`${thermal} kWh/(m²·a)`);

  const efficiencyClass = toStr(getVal(cert, "energyEfficiencyClass"));
  if (efficiencyClass) parts.push(`Klasse ${efficiencyClass}`);

  const sources = asArray(getPath(estate, "energySourcesEnev2014", "energySourceEnev2014"))
    .map((s) => toStr(s))
    .filter((s): s is string => Boolean(s));
  if (sources.length > 0) parts.push(`Energieträger: ${sources.join(", ")}`);

  return parts.length > 0 ? parts.join(", ") : undefined;
}

function normalizeAddress(estate: JsonObject): NormalizedListing["address"] {
  const address = getVal(estate, "address");
  if (!isObject(address)) return undefined;
  const coordinate = getVal(address, "wgs84Coordinate");
  const result = {
    street: toStr(getVal(address, "street")),
    houseNumber: toStr(getVal(address, "houseNumber")),
    zip: toStr(getVal(address, "postcode")) ?? toStr(getVal(address, "zip")),
    city: toStr(getVal(address, "city")),
    region: toStr(getVal(address, "quarter")) ?? toStr(getVal(address, "region")),
    country: toStr(getPath(address, "country", "countryCode")) ?? toStr(getVal(address, "country")) ?? "DE",
    latitude: toNum(getVal(coordinate, "latitude")),
    longitude: toNum(getVal(coordinate, "longitude")),
  };
  const hasContent = Object.values(result).some((v) => v !== undefined);
  return hasContent ? result : undefined;
}

function normalizePrice(estate: JsonObject, typeName: string): {
  price?: number;
  currency?: string;
  marketingType?: string;
} {
  const priceObj = getVal(estate, "price");
  const priceValue = toNum(getVal(priceObj, "value"));
  const currency = toStr(getVal(priceObj, "currency")) ?? "EUR";
  const rawMarketing = toStr(getVal(priceObj, "marketingType"));
  const marketingType = rawMarketing ? MARKETING_TYPE_DE[rawMarketing.toUpperCase()] : undefined;

  // Miettypen: Kaltmiete hat Vorrang vor generischem price.value.
  const baseRent = toNum(getVal(estate, "baseRent"));
  const isRent = typeName.toLowerCase().includes("rent") || marketingType === "Miete";
  const price = isRent ? (baseRent ?? priceValue) : (priceValue ?? baseRent);

  return { price, currency: price !== undefined ? currency : undefined, marketingType };
}

/**
 * Normalisiert ein IS24-Detailobjekt. `detailRoot` ist das Objekt UNTER dem
 * Typ-Schlüssel (z. B. der Wert von "realestate.apartmentBuy"); `typeName`
 * der lokale Typname (z. B. "apartmentBuy").
 */
export function normalizeListing(
  typeName: string,
  detailRoot: unknown,
  attachmentsJson?: unknown,
  summary?: unknown,
): NormalizedListing {
  if (!isObject(detailRoot)) {
    throw new Error(`IS24-Detailobjekt hat ein unerwartetes Format (Typ ${typeName})`);
  }
  const estate = detailRoot;

  const id =
    toStr(getVal(estate, "id")) ??
    toStr(getVal(summary, "id"));
  if (!id) throw new Error(`IS24-Inserat ohne ID (Typ ${typeName})`);

  const title = toStr(getVal(estate, "title")) ?? `Immobilie ${id}`;
  const derived = derivePropertyAndMarketingType(typeName);
  const priceInfo = normalizePrice(estate, typeName);

  const state = toStr(getVal(estate, "realEstateState"));
  const modifiedAt =
    toStr(getVal(estate, "modification")) ??
    toStr(getVal(summary, "modification")) ??
    toStr(getVal(estate, "lastModificationDate"));

  const listing: NormalizedListing = {
    id,
    externalId: toStr(getVal(estate, "externalId")),
    title,
    propertyType: derived.propertyType ?? typeName,
    marketingType: priceInfo.marketingType ?? derived.marketingType,
    status: state ? (state.toUpperCase() === "ACTIVE" ? "aktiv" : state.toLowerCase()) : "aktiv",
    price: priceInfo.price,
    currency: priceInfo.currency,
    livingSpace: toNum(getVal(estate, "livingSpace")),
    usableSpace:
      toNum(getVal(estate, "usableFloorSpace")) ??
      toNum(getVal(estate, "netFloorSpace")) ??
      toNum(getVal(estate, "totalFloorSpace")),
    plotArea: toNum(getVal(estate, "plotArea")),
    rooms: toNum(getVal(estate, "numberOfRooms")),
    bedrooms: toNum(getVal(estate, "numberOfBedRooms")),
    bathrooms: toNum(getVal(estate, "numberOfBathRooms")),
    floor: toNum(getVal(estate, "floor")),
    constructionYear: toNum(getVal(estate, "constructionYear")),
    address: normalizeAddress(estate),
    shortDescription: undefined,
    description: toStr(getVal(estate, "descriptionNote")),
    furnishing: toStr(getVal(estate, "furnishingNote")),
    locationDescription: toStr(getVal(estate, "locationNote")),
    energyCertificate: buildEnergyCertificate(estate),
    exposeUrl: `https://www.immobilienscout24.de/expose/${id}`,
    modifiedAt,
    images: normalizeAttachments(attachmentsJson),
  };

  return listing;
}

/**
 * Extrahiert ausschließlich Bild-Anhänge (keine PDFs, Videos oder Links)
 * in IS24-Reihenfolge.
 */
export function normalizeAttachments(attachmentsJson: unknown): NormalizedImage[] {
  if (!attachmentsJson) return [];
  // Struktur: { "common.attachments": [ { "attachment": [ ... ] } ] }
  const container = getVal(attachmentsJson, "attachments") ?? attachmentsJson;
  const attachmentLists = asArray(container).flatMap((entry) =>
    asArray(getVal(entry, "attachment")),
  );
  const rawAttachments = attachmentLists.length > 0 ? attachmentLists : asArray(getVal(container, "attachment"));

  const images: NormalizedImage[] = [];
  for (const raw of rawAttachments) {
    if (!isObject(raw)) continue;
    const xsiType = toStr(getVal(raw, "type")) ?? "";
    if (!/picture/i.test(xsiType)) continue;

    const id = toStr(getVal(raw, "id"));
    if (!id) continue;

    // urls: [{ url: [{ "@scale": "...", "@href": "..." }] }]
    const urlEntries = asArray(getVal(raw, "urls")).flatMap((u) => asArray(getVal(u, "url")));
    let href: string | undefined;
    let fallback: string | undefined;
    for (const entry of urlEntries) {
      const entryHref = toStr(getVal(entry, "href"));
      if (!entryHref) continue;
      fallback = fallback ?? entryHref;
      const scale = toStr(getVal(entry, "scale"));
      if (scale === "SCALE" || scale === "ORIGINAL") {
        href = entryHref;
        break;
      }
    }
    href = href ?? fallback;
    if (href) {
      // Manche Feeds liefern Platzhalter für Zielauflösung.
      href = href.replace("%WIDTH%", "1920").replace("%HEIGHT%", "1080");
    }

    images.push({
      id,
      url: href,
      title: toStr(getVal(raw, "title")),
      mimeType: undefined,
      order: images.length,
    });
  }
  return images;
}

/** Liest die Elementliste + Paging aus der Listen-Response. */
export function parseRealEstateListPage(json: unknown): {
  elements: Array<{ id: string; typeName: string; raw: JsonObject }>;
  pageNumber: number;
  numberOfPages: number;
  totalHits: number;
} {
  const root = getVal(json, "realEstates");
  if (!isObject(root)) {
    throw new Error("Unerwartete IS24-Listenantwort: 'realestates.realEstates' fehlt");
  }
  const paging = getVal(root, "Paging");
  const pageNumber = toNum(getVal(paging, "pageNumber")) ?? 1;
  const numberOfPages = toNum(getVal(paging, "numberOfPages")) ?? 1;
  const totalHits = toNum(getVal(paging, "numberOfHits")) ?? 0;

  const rawElements = asArray(getPath(root, "realEstateList", "realEstateElement"));
  const elements: Array<{ id: string; typeName: string; raw: JsonObject }> = [];
  for (const raw of rawElements) {
    if (!isObject(raw)) continue;
    const id = toStr(getVal(raw, "id"));
    if (!id) continue;
    const rawType =
      toStr(raw["@xsi.type"]) ?? toStr(getVal(raw, "type")) ?? "realestates:Unknown";
    elements.push({ id, typeName: extractTypeName(rawType), raw });
  }
  return { elements, pageNumber, numberOfPages, totalHits };
}

/** Detail-Response: { "realestate.apartmentBuy": {...} } → Typname + Wurzelobjekt. */
export function parseRealEstateDetail(json: unknown): { typeName: string; root: JsonObject } {
  if (!isObject(json)) throw new Error("Unerwartete IS24-Detailantwort (kein Objekt)");
  for (const [key, value] of Object.entries(json)) {
    if (key.toLowerCase().startsWith("realestate") && isObject(value)) {
      return { typeName: extractTypeName(key), root: value };
    }
  }
  throw new Error("Unerwartete IS24-Detailantwort: kein 'realestate.*'-Schlüssel gefunden");
}
