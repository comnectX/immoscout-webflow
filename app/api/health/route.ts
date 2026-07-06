/**
 * GET /api/health — ohne Auth, ohne externe Aufrufe, ohne Konfigurationsdaten.
 */
export async function GET(): Promise<Response> {
  return Response.json({
    status: "ok",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
  });
}
