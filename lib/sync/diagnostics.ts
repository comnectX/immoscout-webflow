/**
 * Reine Lese-Checks für /api/diagnostics und den Admin-Button
 * „Verbindungen testen". Führt niemals Schreiboperationen aus.
 */
import { AppConfig, configPresence, loadConfig, redactorFromConfig } from "@/lib/config";
import { errorMessage } from "@/lib/errors";
import { Is24Client } from "@/lib/is24/client";
import { createLogger } from "@/lib/log";
import { resolveFieldMapping } from "@/lib/webflow/schema";
import { WebflowClient } from "@/lib/webflow/client";

export interface DiagnosticCheck {
  check: string;
  ok: boolean;
  message: string;
}

export interface DiagnosticsResult {
  success: boolean;
  runId: string;
  checks: DiagnosticCheck[];
  envPresence: Record<string, boolean>;
}

export async function runDiagnostics(runId: string): Promise<DiagnosticsResult> {
  const checks: DiagnosticCheck[] = [];
  const envPresence = configPresence();

  let cfg: AppConfig;
  try {
    cfg = loadConfig();
    checks.push({ check: "config", ok: true, message: "Alle Umgebungsvariablen sind gültig" });
  } catch (err) {
    checks.push({ check: "config", ok: false, message: errorMessage(err) });
    return { success: false, runId, checks, envPresence };
  }

  const logger = createLogger(runId, redactorFromConfig(cfg));
  const webflow = new WebflowClient(cfg, logger);
  const is24 = new Is24Client(cfg, logger);

  // Webflow: Site-Zugriff (prüft Token + Site-ID + Scopes)
  try {
    const site = await webflow.getSite();
    checks.push({
      check: "webflow-site",
      ok: true,
      message: `Webflow-Verbindung OK (Site: ${site.displayName ?? site.id})`,
    });
  } catch (err) {
    checks.push({ check: "webflow-site", ok: false, message: errorMessage(err) });
  }

  // Webflow: Collection + Schema + Feld-Mapping
  try {
    const schema = await webflow.getCollectionSchema();
    checks.push({
      check: "webflow-collection",
      ok: true,
      message: `Collection "${schema.displayName ?? schema.id}" mit ${schema.fields.length} Feldern erreichbar`,
    });
    try {
      const mapping = resolveFieldMapping(schema, cfg.fieldMapOverride);
      const suffix =
        mapping.warnings.length > 0 ? ` — ${mapping.warnings.length} Warnung(en): ${mapping.warnings.join(" | ")}` : "";
      checks.push({
        check: "webflow-schema",
        ok: true,
        message: `Feld-Mapping gültig (${mapping.entries.size} Felder gemappt)${suffix}`,
      });
    } catch (err) {
      checks.push({ check: "webflow-schema", ok: false, message: errorMessage(err) });
    }
  } catch (err) {
    checks.push({ check: "webflow-collection", ok: false, message: errorMessage(err) });
  }

  // IS24: Authentifizierung + Zugriff auf die Inseratsliste
  try {
    const { totalHits } = await is24.listAllRealEstates();
    checks.push({
      check: "is24-listings",
      ok: true,
      message: `IS24-Authentifizierung OK, ${totalHits} Inserate im Channel "${cfg.is24PublishChannel}"`,
    });
  } catch (err) {
    checks.push({
      check: "is24-listings",
      ok: false,
      message: `${errorMessage(err)} — prüfen Sie Consumer-Key/-Secret, Access-Token und ob der Account die Berechtigung für publishchannel "${cfg.is24PublishChannel}" hat (alternativ "IS24")`,
    });
  }

  return { success: checks.every((c) => c.ok), runId, checks, envPresence };
}
