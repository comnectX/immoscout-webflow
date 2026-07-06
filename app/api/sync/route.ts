import { loadConfig } from "@/lib/config";
import { ConfigError, errorMessage } from "@/lib/errors";
import { newRunId } from "@/lib/log";
import { checkBearerAuth, unauthorizedResponse } from "@/lib/security/auth";
import { executeSyncRun, RunOverrides } from "@/lib/sync/runner";

function parseBoolParam(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  return ["true", "1", "yes"].includes(value.toLowerCase());
}

/**
 * POST /api/sync — geschützt mit Authorization: Bearer {SYNC_SECRET}.
 * Query-Parameter: dryRun, syncImages, inactiveAction.
 * GET startet NIEMALS eine Synchronisierung (siehe unten).
 */
export async function POST(req: Request): Promise<Response> {
  const runId = newRunId();

  const syncSecret = process.env.SYNC_SECRET;
  if (!syncSecret || syncSecret.length < 16) {
    return Response.json(
      { success: false, runId, errors: ["SYNC_SECRET ist nicht konfiguriert"] },
      { status: 500 },
    );
  }
  if (!(await checkBearerAuth(req, syncSecret))) return unauthorizedResponse(runId);

  let overrides: RunOverrides;
  try {
    const url = new URL(req.url);
    const inactiveActionRaw = url.searchParams.get("inactiveAction");
    if (inactiveActionRaw && !["unpublish", "ignore"].includes(inactiveActionRaw)) {
      return Response.json(
        { success: false, runId, errors: ['inactiveAction muss "unpublish" oder "ignore" sein'] },
        { status: 400 },
      );
    }
    overrides = {
      dryRun: parseBoolParam(url.searchParams.get("dryRun")),
      syncImages: parseBoolParam(url.searchParams.get("syncImages")),
      inactiveAction: inactiveActionRaw as RunOverrides["inactiveAction"],
    };
  } catch {
    return Response.json({ success: false, runId, errors: ["Ungültige Request-URL"] }, { status: 400 });
  }

  try {
    const cfg = loadConfig();
    const report = await executeSyncRun(cfg, runId, overrides);
    return Response.json(report, { status: report.success ? 200 : 502 });
  } catch (err) {
    const status = err instanceof ConfigError ? 500 : 502;
    return Response.json(
      { success: false, runId, errors: [errorMessage(err)] },
      { status },
    );
  }
}

export async function GET(): Promise<Response> {
  return Response.json(
    { error: "Synchronisierung nur per POST. GET startet niemals einen Sync." },
    { status: 405, headers: { Allow: "POST" } },
  );
}
