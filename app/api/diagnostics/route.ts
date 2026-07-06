import { newRunId } from "@/lib/log";
import { checkBearerAuth, unauthorizedResponse } from "@/lib/security/auth";
import { runDiagnostics } from "@/lib/sync/diagnostics";

/**
 * POST /api/diagnostics — geschützt mit Authorization: Bearer {SYNC_SECRET}.
 * Reine Lese-Checks, keine Schreiboperationen.
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

  const result = await runDiagnostics(runId);
  return Response.json(result, { status: result.success ? 200 : 502 });
}
