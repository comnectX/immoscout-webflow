/**
 * Temporäre Diagnose-Route: zeigt ausschließlich Host-/Proxy-Header,
 * um die Origin-Prüfung hinter dem Webflow-Cloud-Proxy zu kalibrieren.
 * Keine Cookies, keine Authorization, keine Secrets.
 * TODO: nach abgeschlossener Einrichtung entfernen.
 */
export async function GET(req: Request): Promise<Response> {
  const pick = [
    "host",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-original-host",
    "forwarded",
    "origin",
    "via",
  ];
  return Response.json({
    url: req.url,
    headers: Object.fromEntries(pick.map((h) => [h, req.headers.get(h)])),
  });
}
