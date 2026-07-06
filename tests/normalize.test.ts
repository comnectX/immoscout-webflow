import { describe, expect, it } from "vitest";
import {
  normalizeAttachments,
  normalizeListing,
  parseRealEstateDetail,
  parseRealEstateListPage,
} from "@/lib/is24/normalize";

const apartmentBuyDetail = {
  "realestate.apartmentBuy": {
    "@id": "123456789",
    "@modification": "2026-06-01T10:00:00.000+02:00",
    externalId: "OBJ-42",
    title: "Helle 3-Zimmer Wohnung",
    address: {
      street: "Musterstraße",
      houseNumber: "12a",
      postcode: "50667",
      city: "Köln",
      quarter: "Altstadt",
      wgs84Coordinate: { latitude: 50.9375, longitude: 6.9603 },
    },
    price: { value: 349000, currency: "EUR", marketingType: "PURCHASE" },
    livingSpace: 92.5,
    numberOfRooms: 3,
    numberOfBedRooms: 2,
    numberOfBathRooms: 1,
    floor: 2,
    constructionYear: 1998,
    descriptionNote: "Tolle Wohnung.\n\nMit Balkon.",
    furnishingNote: "Einbauküche",
    locationNote: "Zentrale Lage",
    buildingEnergyRatingType: "ENERGY_CONSUMPTION",
    thermalCharacteristic: 120.5,
    energyCertificate: {
      energyCertificateAvailability: "AVAILABLE",
      energyEfficiencyClass: "C",
    },
    realEstateState: "ACTIVE",
  },
};

const houseRentDetail = {
  "realestate.houseRent": {
    "@id": "987654321",
    title: "Familienhaus zur Miete",
    address: { postcode: "80331", city: "München" },
    baseRent: 2400,
    price: { value: 2400, currency: "EUR", marketingType: "RENT" },
    plotArea: 420,
    livingSpace: "160", // IS24 liefert Zahlen teils als String
    numberOfRooms: 5,
    descriptionNote: "", // leere Strings dürfen nicht durchgereicht werden
  },
};

const attachmentsJson = {
  "common.attachments": [
    {
      attachment: [
        {
          "@xsi.type": "common:Picture",
          "@id": "111",
          title: "Wohnzimmer",
          urls: [
            {
              url: [
                { "@scale": "SCALE_AND_CROP", "@href": "https://pic.example/111-crop.jpg" },
                { "@scale": "SCALE", "@href": "https://pic.example/111-full.jpg" },
              ],
            },
          ],
        },
        { "@xsi.type": "common:PDFDocument", "@id": "222", title: "Exposé" },
        {
          "@xsi.type": "common:Picture",
          "@id": "333",
          urls: [{ url: [{ "@scale": "SCALE", "@href": "https://pic.example/333.jpg" }] }],
        },
        { "@xsi.type": "common:StreamingVideo", "@id": "444" },
        { "@xsi.type": "common:Link", "@id": "555" },
      ],
    },
  ],
};

describe("parseRealEstateDetail", () => {
  it("erkennt Typ und Wurzelobjekt aus dem namensraumbehafteten Schlüssel", () => {
    const { typeName, root } = parseRealEstateDetail(apartmentBuyDetail);
    expect(typeName).toBe("apartmentBuy");
    expect(root.title).toBe("Helle 3-Zimmer Wohnung");
  });

  it("wirft bei unerwartetem Format", () => {
    expect(() => parseRealEstateDetail({ foo: "bar" })).toThrow();
  });
});

describe("normalizeListing", () => {
  it("normalisiert eine Kauf-Wohnung vollständig", () => {
    const { typeName, root } = parseRealEstateDetail(apartmentBuyDetail);
    const listing = normalizeListing(typeName, root, attachmentsJson);

    expect(listing.id).toBe("123456789");
    expect(listing.externalId).toBe("OBJ-42");
    expect(listing.title).toBe("Helle 3-Zimmer Wohnung");
    expect(listing.propertyType).toBe("Wohnung");
    expect(listing.marketingType).toBe("Kauf");
    expect(listing.status).toBe("aktiv");
    expect(listing.price).toBe(349000);
    expect(listing.currency).toBe("EUR");
    expect(listing.livingSpace).toBe(92.5);
    expect(listing.rooms).toBe(3);
    expect(listing.floor).toBe(2);
    expect(listing.constructionYear).toBe(1998);
    expect(listing.address?.street).toBe("Musterstraße");
    expect(listing.address?.zip).toBe("50667");
    expect(listing.address?.city).toBe("Köln");
    expect(listing.address?.latitude).toBeCloseTo(50.9375);
    expect(listing.energyCertificate).toContain("Verbrauchsausweis");
    expect(listing.energyCertificate).toContain("Klasse C");
    expect(listing.exposeUrl).toBe("https://www.immobilienscout24.de/expose/123456789");
    expect(listing.modifiedAt).toBe("2026-06-01T10:00:00.000+02:00");
    expect(listing.images).toHaveLength(2);
  });

  it("normalisiert ein Miet-Haus mit abweichender Struktur", () => {
    const { typeName, root } = parseRealEstateDetail(houseRentDetail);
    const listing = normalizeListing(typeName, root);

    expect(listing.propertyType).toBe("Haus");
    expect(listing.marketingType).toBe("Miete");
    expect(listing.price).toBe(2400); // baseRent hat Vorrang bei Miete
    expect(listing.plotArea).toBe(420);
    expect(listing.livingSpace).toBe(160); // String → Zahl
    expect(listing.description).toBeUndefined(); // leerer String → weggelassen
    expect(listing.bedrooms).toBeUndefined();
    expect(listing.images).toEqual([]);
  });

  it("wirft bei Inserat ohne ID", () => {
    expect(() => normalizeListing("apartmentBuy", { title: "ohne id" })).toThrow(/ohne ID/);
  });
});

describe("normalizeAttachments", () => {
  it("übernimmt nur Bilder, in IS24-Reihenfolge, bevorzugt SCALE-URLs", () => {
    const images = normalizeAttachments(attachmentsJson);
    expect(images).toHaveLength(2);
    expect(images[0]).toMatchObject({
      id: "111",
      url: "https://pic.example/111-full.jpg",
      title: "Wohnzimmer",
      order: 0,
    });
    expect(images[1]).toMatchObject({ id: "333", order: 1 });
  });

  it("ersetzt Auflösungs-Platzhalter in URLs", () => {
    const images = normalizeAttachments({
      "common.attachments": [
        {
          attachment: {
            "@xsi.type": "common:Picture",
            "@id": "7",
            urls: { url: { "@href": "https://pic.example/7/%WIDTH%x%HEIGHT%.jpg" } },
          },
        },
      ],
    });
    expect(images[0]?.url).toBe("https://pic.example/7/1920x1080.jpg");
  });

  it("liefert leeres Array bei fehlenden Anhängen", () => {
    expect(normalizeAttachments(undefined)).toEqual([]);
    expect(normalizeAttachments({})).toEqual([]);
  });
});

describe("parseRealEstateListPage", () => {
  it("parst Elemente und Paging inkl. Einzelobjekt statt Array", () => {
    const page = parseRealEstateListPage({
      "realestates.realEstates": {
        Paging: { pageNumber: 1, numberOfPages: 2, numberOfHits: 3 },
        realEstateList: {
          realEstateElement: {
            "@id": "42",
            "@xsi.type": "realestates:HouseBuy",
            title: "Einzelnes Haus",
          },
        },
      },
    });
    expect(page.numberOfPages).toBe(2);
    expect(page.totalHits).toBe(3);
    expect(page.elements).toHaveLength(1);
    expect(page.elements[0]).toMatchObject({ id: "42", typeName: "houseBuy" });
  });

  it("wirft bei fehlender Wurzel", () => {
    expect(() => parseRealEstateListPage({ unexpected: true })).toThrow();
  });
});
