import type { InactiveAction } from "@/lib/config";
import { SyncError, errorMessage } from "@/lib/errors";
import type { ListingSource, SourceFetchResult } from "@/lib/is24/client";
import type { NormalizedListing } from "@/lib/is24/normalize";
import { Logger } from "@/lib/log";
import { computeListingHash } from "@/lib/sync/hash";
import { ReportBuilder, SyncReport } from "@/lib/sync/report";
import { buildListingSlug } from "@/lib/sync/slug";
import { pMap } from "@/lib/util/concurrency";
import type { ImageResolver } from "@/lib/webflow/assets";
import type { FieldMap, ResolvedMapping } from "@/lib/webflow/schema";
import { resolveFieldMapping } from "@/lib/webflow/schema";
import { buildFieldData } from "@/lib/webflow/mapper";
import type { WebflowGateway, WebflowItem, WebflowItemUpdate, WebflowItemWrite } from "@/lib/webflow/client";

export interface SyncOptions {
  dryRun: boolean;
  syncImages: boolean;
  inactiveAction: InactiveAction;
  maxConcurrency: number;
  fieldMapOverride: FieldMap | null;
  /**
   * Zeitbudget pro Lauf in ms (0/undefined = unbegrenzt). Ist es erschöpft,
   * werden keine weiteren Blöcke begonnen; der Bericht meldet complete=false
   * und der nächste Aufruf macht über den Hash-Diff dort weiter. Hält jeden
   * Aufruf unter dem Gateway-Timeout (Cloudflare 504 nach ~100 s).
   */
  timeBudgetMs?: number;
}

export interface SyncDeps {
  source: ListingSource;
  webflow: WebflowGateway;
  imageResolver: ImageResolver;
  logger: Logger;
}

interface PlannedWrite {
  listing: NormalizedListing;
  hash: string;
  existing?: WebflowItem;
}

/**
 * Einseitige Synchronisierung IS24 → Webflow. IS24 ist Source of Truth.
 * Reihenfolge: erst ALLE Lesezugriffe (Schema, CMS-Items, IS24 komplett),
 * dann Diff, dann Writes. Scheitert der Quell-Abruf, ist noch nichts
 * geschrieben worden — der Lauf bricht gefahrlos ab.
 */
export async function runSync(deps: SyncDeps, opts: SyncOptions, runId: string): Promise<SyncReport> {
  const { logger } = deps;
  const report = new ReportBuilder(runId, opts.dryRun);

  try {
    return await execute(deps, opts, report);
  } catch (err) {
    const msg = err instanceof SyncError ? `[${err.code}] ${err.message}` : errorMessage(err);
    report.error(msg);
    logger.error("Sync abgebrochen", { error: msg });
    return report.build(false);
  }
}

async function execute(deps: SyncDeps, opts: SyncOptions, report: ReportBuilder): Promise<SyncReport> {
  const { source, webflow, imageResolver, logger } = deps;
  const deadline = opts.timeBudgetMs ? Date.now() + opts.timeBudgetMs : Number.POSITIVE_INFINITY;
  const outOfTime = () => Date.now() >= deadline;

  // 1+2: Collection-Schema laden und Mapping validieren (wirft MappingError,
  // wenn is24-id/name/slug fehlen — vor jeglichen Schreibzugriffen).
  const schema = await webflow.getCollectionSchema();
  const mapping: ResolvedMapping = resolveFieldMapping(schema, opts.fieldMapOverride);
  mapping.warnings.forEach((w) => report.warn(w));
  logger.info("Collection-Schema geladen", {
    collection: schema.displayName,
    mappedFields: mapping.entries.size,
  });

  // 3+4: Alle vorhandenen Items (inkl. Entwürfe) laden, Map über is24-id.
  const existingItems = await webflow.listAllItems();
  report.existingWebflowCount = existingItems.length;
  const groups = new Map<string, WebflowItem[]>();
  const existingSlugs = new Set<string>();
  for (const item of existingItems) {
    const slug = item.fieldData.slug;
    if (typeof slug === "string") existingSlugs.add(slug);
    const rawId = item.fieldData[mapping.idSlug];
    if (typeof rawId !== "string" || rawId.trim() === "") continue; // manuell erstellte Items: unantastbar
    const is24Id = rawId.trim();
    const group = groups.get(is24Id);
    if (group) group.push(item);
    else groups.set(is24Id, [item]);
  }

  // Duplikate (mehrere Items mit derselben is24-id): das veröffentlichte bzw.
  // älteste Item bleibt maßgeblich, weitere live Kopien werden unten
  // unveröffentlicht (nie gelöscht).
  const byIs24Id = new Map<string, WebflowItem>();
  const duplicatesToRetire: Array<[string, WebflowItem]> = [];
  for (const [is24Id, group] of groups) {
    const [canonical, ...rest] = [...group].sort(compareCanonical);
    byIs24Id.set(is24Id, canonical!);
    for (const dup of rest) {
      report.warn(
        `Duplikat in Webflow: mehrere Items mit is24-id "${is24Id}" — Item ${dup.id} wird ignoriert` +
          (dup.isDraft ? "" : " und unveröffentlicht"),
      );
      if (!dup.isDraft) duplicatesToRetire.push([is24Id, dup]);
    }
  }

  // 5–7: IS24 vollständig abrufen und normalisieren. Wirft bei Auth-Fehlern,
  // Rate-Limit oder unvollständiger Pagination — dann wurde nichts geschrieben.
  const fetchResult: SourceFetchResult = await source.fetchListings({
    includeAttachments: opts.syncImages,
    concurrency: opts.maxConcurrency,
  });
  report.sourceCount = fetchResult.listings.length + fetchResult.failedIds.length;
  for (const failedId of fetchResult.failedIds) {
    report.error(`Inserat ${failedId}: Detail-Abruf fehlgeschlagen — wird in diesem Lauf übersprungen`);
  }

  // Sicherheitsregel: Unpublishing nur bei nachweislich vollständigem Abruf
  // ohne Detail-/Parsingfehler.
  const canUnpublish = fetchResult.complete && fetchResult.failedIds.length === 0;
  if (!canUnpublish && opts.inactiveAction === "unpublish") {
    report.warn(
      "IS24-Abruf war nicht vollständig fehlerfrei — Unpublishing wird in diesem Lauf ausgesetzt (Sicherheitsregel)",
    );
  }

  // 8: Stabiler Inhalts-Hash pro Inserat.
  const hashed: PlannedWrite[] = await Promise.all(
    fetchResult.listings.map(async (listing) => ({
      listing,
      hash: await computeListingHash(listing),
      existing: byIs24Id.get(listing.id),
    })),
  );

  // Diff: create / update / unchanged.
  const toCreate: PlannedWrite[] = [];
  const toUpdate: PlannedWrite[] = [];
  for (const plan of hashed) {
    if (!plan.existing) {
      toCreate.push(plan);
      continue;
    }
    const existingHash = mapping.syncHashSlug
      ? plan.existing.fieldData[mapping.syncHashSlug]
      : undefined;
    const needsReactivation = plan.existing.isDraft || plan.existing.isArchived;
    if (existingHash === plan.hash && !needsReactivation) {
      report.unchanged.push({
        is24Id: plan.listing.id,
        title: plan.listing.title,
        webflowItemId: plan.existing.id,
      });
    } else {
      toUpdate.push(plan);
    }
  }

  // Verschwundene Inserate: nur Items MIT is24-id, deren ID weder in den
  // geladenen Listings noch in den fehlgeschlagenen Details vorkommt.
  const sourceIds = new Set<string>([
    ...fetchResult.listings.map((l) => l.id),
    ...fetchResult.failedIds,
  ]);
  // Bereits unveröffentlichte Items (Entwürfe) sind schon offline — sie bei
  // jedem Lauf erneut zu unpublishen kostet nur Zeit und API-Calls.
  const stale = [...byIs24Id.entries()].filter(([id, item]) => !sourceIds.has(id) && !item.isDraft);

  const nowIso = new Date().toISOString();

  // Bilder werden pro Block nur für Items aufgelöst, die tatsächlich
  // geschrieben werden — unveränderte Inserate lösen keine Downloads/Uploads aus.
  const imagesByListing = new Map<string, Awaited<ReturnType<ImageResolver["resolve"]>>>();
  const resolveImages = async (plans: PlannedWrite[]) => {
    if (!opts.syncImages || opts.dryRun) return;
    const resolved = await pMap(
      plans,
      async (plan) => ({ id: plan.listing.id, images: await imageResolver.resolve(plan.listing) }),
      opts.maxConcurrency,
    );
    for (const { id, images } of resolved) {
      imagesByListing.set(id, images);
      images.warnings.forEach((w) => report.warn(w));
    }
  };

  const fieldDataFor = (plan: PlannedWrite): Record<string, unknown> => {
    const images = imagesByListing.get(plan.listing.id);
    const { fieldData, warnings } = buildFieldData({
      listing: plan.listing,
      mapping,
      syncHash: plan.hash,
      lastSyncedAt: nowIso,
      mainImage: images?.mainImage,
      gallery: images?.gallery,
    });
    warnings.forEach((w) => report.warn(w));
    return fieldData;
  };

  // ── Dry-Run: alles berechnet, nichts geschrieben ───────────────────────────
  if (opts.dryRun) {
    for (const plan of toCreate) {
      report.created.push({
        is24Id: plan.listing.id,
        title: plan.listing.title,
        slug: buildListingSlug(plan.listing.title, plan.listing.id),
      });
    }
    for (const plan of toUpdate) {
      report.updated.push({
        is24Id: plan.listing.id,
        title: plan.listing.title,
        webflowItemId: plan.existing?.id,
      });
    }
    for (const [id, item] of stale) {
      report.wouldUnpublish.push({
        is24Id: id,
        title: typeof item.fieldData.name === "string" ? item.fieldData.name : undefined,
        webflowItemId: item.id,
      });
    }
    logger.info("Dry-Run abgeschlossen — keine Webflow-Schreibzugriffe", {
      create: toCreate.length,
      update: toUpdate.length,
      unchanged: report.unchanged.length,
      wouldUnpublish: stale.length,
    });
    return report.build(report.errors.length === 0);
  }

  // ── 9–11: Writes in kleinen Blöcken (Bilder → Create/Update → Publish) ────
  // Jeder Block ist für sich abgeschlossen und veröffentlicht. Ist das
  // Zeitbudget erschöpft, wird kein neuer Block begonnen; der nächste Lauf
  // findet die restlichen Inserate über den Hash-Diff wieder.
  const writes = [...toCreate, ...toUpdate];
  const blockSize = Math.max(1, opts.maxConcurrency * 2);
  for (let i = 0; i < writes.length; i += blockSize) {
    if (outOfTime()) {
      const remaining = writes.length - i;
      report.pendingCount += remaining;
      report.warn(`Zeitbudget erschöpft — ${remaining} Inserate werden im nächsten Aufruf geschrieben`);
      break;
    }
    await writeBlock(writes.slice(i, i + blockSize));
  }

  async function writeBlock(block: PlannedWrite[]): Promise<void> {
    await resolveImages(block);
    const publishIds: string[] = [];

    // 9: Neue Inserate staged anlegen
    const creates = block.filter((plan) => !plan.existing);
    if (creates.length > 0) {
      const createPayloads: WebflowItemWrite[] = creates.map((plan) => {
        let slug = buildListingSlug(plan.listing.title, plan.listing.id);
        if (existingSlugs.has(slug)) slug = `${slug}-2`;
        existingSlugs.add(slug);
        return {
          isDraft: false,
          isArchived: false,
          fieldData: { ...fieldDataFor(plan), slug },
        };
      });
      const createdItems = await webflow.createItems(createPayloads);
      createdItems.forEach((item, i) => {
        const plan = creates[i];
        if (!plan) return;
        publishIds.push(item.id);
        report.created.push({
          is24Id: plan.listing.id,
          title: plan.listing.title,
          slug: typeof item.fieldData?.slug === "string" ? item.fieldData.slug : undefined,
          webflowItemId: item.id,
        });
      });
      logger.info(`${createdItems.length} Items staged erstellt`);
    }

    // 10: Geänderte Inserate staged aktualisieren (Slug bleibt stabil)
    const updates = block.filter((plan) => plan.existing);
    if (updates.length > 0) {
      const updatePayloads: WebflowItemUpdate[] = updates.map((plan) => ({
        id: plan.existing!.id,
        isDraft: false,
        isArchived: false,
        fieldData: fieldDataFor(plan),
      }));
      await webflow.updateItems(updatePayloads);
      for (const plan of updates) {
        publishIds.push(plan.existing!.id);
        report.updated.push({
          is24Id: plan.listing.id,
          title: plan.listing.title,
          webflowItemId: plan.existing!.id,
        });
      }
      logger.info(`${updates.length} Items staged aktualisiert`);
    }

    // 11: Nur betroffene Items veröffentlichen (kein Site-Publish)
    if (publishIds.length > 0) {
      await webflow.publishItems(publishIds);
      logger.info(`${publishIds.length} Items veröffentlicht`);
    }
  }

  // Unveröffentlicht ein Item und markiert es als Entwurf (staged bleibt erhalten).
  const retire = async (id: string, item: WebflowItem): Promise<boolean> => {
    if (outOfTime()) {
      report.pendingCount += 1;
      return false;
    }
    try {
      await webflow.unpublishItem(item.id);
      await webflow.updateItems([{ id: item.id, isDraft: true, fieldData: {} }]);
      report.unpublished.push({
        is24Id: id,
        title: typeof item.fieldData.name === "string" ? item.fieldData.name : undefined,
        webflowItemId: item.id,
      });
      return true;
    } catch (err) {
      report.error(`Unpublish für Item ${item.id} (is24-id ${id}) fehlgeschlagen: ${errorMessage(err)}`);
      return false;
    }
  };

  // ── 12: Live-Duplikate bereinigen (unabhängig von INACTIVE_ACTION) ────────
  for (const [id, item] of duplicatesToRetire) await retire(id, item);

  // ── 13: Verschwundene Inserate behandeln ──────────────────────────────────
  if (stale.length > 0) {
    if (opts.inactiveAction === "ignore") {
      for (const [id, item] of stale) {
        report.wouldUnpublish.push({ is24Id: id, webflowItemId: item.id });
      }
      report.warn(`${stale.length} inaktive Inserate ignoriert (INACTIVE_ACTION=ignore)`);
    } else if (!canUnpublish) {
      for (const [id, item] of stale) {
        report.wouldUnpublish.push({ is24Id: id, webflowItemId: item.id });
      }
    } else {
      let count = 0;
      for (const [id, item] of stale) if (await retire(id, item)) count++;
      logger.info(`${count} Items unveröffentlicht (staged bleibt erhalten)`);
    }
  }

  if (report.pendingCount > 0) {
    logger.info(`Lauf wegen Zeitbudget vorzeitig beendet`, { pending: report.pendingCount });
  }
  return report.build(report.errors.length === 0);
}

/** Maßgebliches Item bei Duplikaten: zuerst nicht-Entwurf, dann ältestes. */
function compareCanonical(a: WebflowItem, b: WebflowItem): number {
  if (a.isDraft !== b.isDraft) return a.isDraft ? 1 : -1;
  if (a.createdOn && b.createdOn && a.createdOn !== b.createdOn) {
    return a.createdOn < b.createdOn ? -1 : 1;
  }
  return 0;
}
