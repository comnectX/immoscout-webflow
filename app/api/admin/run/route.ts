import { requireAdminSession } from "@/app/api/admin/_lib";
import { loadConfig } from "@/lib/config";
import { ConfigError, errorMessage } from "@/lib/errors";
import { newRunId } from "@/lib/log";
import { runDiagnostics } from "@/lib/sync/diagnostics";
import { executeSyncRun } from "@/lib/sync/runner";

interface RunBody {
  action?: unknown;
}

/**
 * POST /api/admin/run — führt Admin-Aktionen serverseitig aus.
 * Body: { action: "diagnostics" | "dryRun" | "sync" }
 * Auth: Session-Cookie + Origin-Prüfung. Der Browser sieht niemals
 * SYNC_SECRET oder API-Tokens.
 */
export async function POST(req: Request): Promise<Response> {
  const denied = await requireAdminSession(req);
  if (denied) return denied;

  const runId = newRunId();
  let action = "";
  try {
    const body = (await req.json()) as RunBody;
    if (typeof body.action === "string") action = body.action;
  } catch {
    // fällt unten in die Validierung
  }

  if (!["diagnostics", "dryRun", "sync"].includes(action)) {
    return Response.json(
      { success: false, runId, errors: ['action muss "diagnostics", "dryRun" oder "sync" sein'] },
      { status: 400 },
    );
  }

  try {
    if (action === "diagnostics") {
      const result = await runDiagnostics(runId);
      return Response.json(result, { status: result.success ? 200 : 502 });
    }
    const cfg = loadConfig();
    const report = await executeSyncRun(cfg, runId, {
      // "Jetzt synchronisieren" erzwingt einen echten Lauf, auch wenn
      // DRY_RUN=true als sicherer Default gesetzt ist.
      dryRun: action === "dryRun" ? true : false,
    });
    return Response.json(report, { status: report.success ? 200 : 502 });
  } catch (err) {
    const status = err instanceof ConfigError ? 500 : 502;
    return Response.json({ success: false, runId, errors: [errorMessage(err)] }, { status });
  }
}
