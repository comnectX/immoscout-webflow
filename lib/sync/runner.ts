/**
 * Verdrahtet Konfiguration, Clients und Engine für einen Sync-Lauf.
 * Wird von /api/sync und der Admin-Oberfläche gemeinsam genutzt.
 */
import { AppConfig, redactorFromConfig } from "@/lib/config";
import { Is24Client } from "@/lib/is24/client";
import { createLogger } from "@/lib/log";
import { runSync, SyncOptions } from "@/lib/sync/engine";
import { SyncReport } from "@/lib/sync/report";
import { NoopImageResolver, WebflowAssetImageResolver } from "@/lib/webflow/assets";
import { WebflowClient } from "@/lib/webflow/client";

export interface RunOverrides {
  dryRun?: boolean;
  syncImages?: boolean;
  inactiveAction?: "unpublish" | "ignore";
}

export async function executeSyncRun(
  cfg: AppConfig,
  runId: string,
  overrides: RunOverrides,
): Promise<SyncReport> {
  const logger = createLogger(runId, redactorFromConfig(cfg));

  const options: SyncOptions = {
    dryRun: overrides.dryRun ?? cfg.dryRunDefault,
    syncImages: overrides.syncImages ?? cfg.syncImagesDefault,
    inactiveAction: overrides.inactiveAction ?? cfg.inactiveActionDefault,
    maxConcurrency: cfg.maxConcurrency,
    fieldMapOverride: cfg.fieldMapOverride,
  };

  const is24 = new Is24Client(cfg, logger);
  const webflow = new WebflowClient(cfg, logger);
  const imageResolver =
    options.syncImages && !options.dryRun
      ? new WebflowAssetImageResolver(webflow, is24, logger)
      : new NoopImageResolver();

  logger.info("Sync-Lauf gestartet", {
    dryRun: options.dryRun,
    syncImages: options.syncImages,
    inactiveAction: options.inactiveAction,
  });

  const report = await runSync({ source: is24, webflow, imageResolver, logger }, options, runId);

  logger.info("Sync-Lauf beendet", {
    success: report.success,
    created: report.createCount,
    updated: report.updateCount,
    unchanged: report.unchangedCount,
    unpublished: report.unpublishCount,
    errors: report.errorCount,
  });
  return report;
}
