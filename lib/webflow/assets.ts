import { AssetError, errorMessage } from "@/lib/errors";
import type { ListingSource } from "@/lib/is24/client";
import type { NormalizedImage, NormalizedListing } from "@/lib/is24/normalize";
import { Logger } from "@/lib/log";
import { md5Hex } from "@/lib/util/md5";
import { buildAltText, ImageRef } from "@/lib/webflow/mapper";
import type { WebflowClient } from "@/lib/webflow/client";

/** Webflow-Limit für Bilder in CMS-Feldern. */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
};

export interface ResolvedImages {
  mainImage?: ImageRef;
  gallery: ImageRef[];
  warnings: string[];
}

export interface ImageResolver {
  resolve(listing: NormalizedListing): Promise<ResolvedImages>;
}

/** Dry-Run / SYNC_IMAGES=false: keine Downloads, keine Uploads. */
export class NoopImageResolver implements ImageResolver {
  async resolve(): Promise<ResolvedImages> {
    return { mainImage: undefined, gallery: [], warnings: [] };
  }
}

/**
 * Lädt IS24-Bilder (öffentlich oder OAuth-signiert), validiert MIME-Type
 * und Größe und lädt sie dedupliziert in die Webflow Assets API hoch.
 *
 * Dateinamens-Schema: is24-{listingId}-{attachmentId}-{contentHash}.{ext}
 * Deduplizierung in zwei Stufen:
 *  1. Präfix is24-{listingId}-{attachmentId}- bereits als Asset vorhanden
 *     → Wiederverwendung ohne Download.
 *  2. Nach Download: exakter Dateiname (inkl. Content-Hash) vorhanden
 *     → Wiederverwendung ohne Upload.
 */
export class WebflowAssetImageResolver implements ImageResolver {
  private assetIndex: Map<string, string> | null = null;

  constructor(
    private readonly webflow: WebflowClient,
    private readonly source: ListingSource,
    private readonly logger: Logger,
  ) {}

  private async loadAssetIndex(): Promise<Map<string, string>> {
    if (this.assetIndex) return this.assetIndex;
    const index = new Map<string, string>();
    const assets = await this.webflow.listAllAssets();
    for (const asset of assets) {
      const name = asset.originalFileName ?? asset.displayName;
      if (name && asset.hostedUrl) index.set(name, asset.hostedUrl);
    }
    this.assetIndex = index;
    this.logger.info(`Webflow-Asset-Index geladen`, { assetCount: index.size });
    return index;
  }

  private findByPrefix(index: Map<string, string>, prefix: string): string | undefined {
    for (const [name, url] of index) {
      if (name.startsWith(prefix)) return url;
    }
    return undefined;
  }

  private async resolveOne(
    listing: NormalizedListing,
    image: NormalizedImage,
    warnings: string[],
  ): Promise<ImageRef | null> {
    if (!image.url) {
      warnings.push(`Inserat ${listing.id}: Bild ${image.id} hat keine URL — übersprungen`);
      return null;
    }
    const index = await this.loadAssetIndex();
    const identityPrefix = `is24-${listing.id}-${image.id}-`;
    const alt = buildAltText(listing.title, image.title, image.order);

    const existing = this.findByPrefix(index, identityPrefix);
    if (existing) return { url: existing, alt };

    const { bytes, contentType } = await this.source.fetchImage(image.url);
    const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
    const extension = EXTENSION_BY_MIME[mime];
    if (!extension) {
      warnings.push(
        `Inserat ${listing.id}: Anhang ${image.id} ist kein unterstütztes Bild (${mime || "unbekannt"}) — übersprungen`,
      );
      return null;
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
      warnings.push(
        `Inserat ${listing.id}: Bild ${image.id} ist ${(bytes.length / 1024 / 1024).toFixed(1)} MB (> 4 MB CMS-Limit) — übersprungen`,
      );
      return null;
    }

    const contentHash = md5Hex(bytes);
    const fileName = `${identityPrefix}${contentHash.slice(0, 12)}.${extension}`;

    const byExactName = index.get(fileName);
    if (byExactName) return { url: byExactName, alt };

    const meta = await this.webflow.createAssetMetadata(fileName, contentHash);
    await this.webflow.uploadAssetBinary(meta.uploadUrl, meta.uploadDetails, bytes, mime, fileName);
    if (!meta.hostedUrl) {
      throw new AssetError(`Webflow lieferte keine hostedUrl für Asset ${fileName}`);
    }
    index.set(fileName, meta.hostedUrl);
    this.logger.info(`Asset hochgeladen`, { fileName, bytes: bytes.length });
    return { url: meta.hostedUrl, alt };
  }

  async resolve(listing: NormalizedListing): Promise<ResolvedImages> {
    const warnings: string[] = [];
    const gallery: ImageRef[] = [];

    // Sequentiell pro Inserat → IS24-Reihenfolge bleibt garantiert erhalten.
    for (const image of [...listing.images].sort((a, b) => a.order - b.order)) {
      try {
        const ref = await this.resolveOne(listing, image, warnings);
        if (ref) gallery.push(ref);
      } catch (err) {
        // Einzelnes Bild scheitert → Inserat trotzdem synchronisieren.
        warnings.push(
          `Inserat ${listing.id}: Bild ${image.id} konnte nicht verarbeitet werden: ${errorMessage(err)}`,
        );
      }
    }

    return { mainImage: gallery[0], gallery, warnings };
  }
}
