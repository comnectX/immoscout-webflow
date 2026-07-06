import { isSameOrigin, SESSION_COOKIE, verifySessionToken } from "@/lib/security/session";

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export function readSessionCookie(req: Request): string | undefined {
  const cookieHeader = req.headers.get("cookie") ?? "";
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=");
  }
  return undefined;
}

/**
 * Autorisierung für schreibende Admin-Requests:
 * gültige Session + Same-Origin (CSRF-Schutz).
 */
export async function requireAdminSession(req: Request): Promise<Response | null> {
  const syncSecret = process.env.SYNC_SECRET;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!syncSecret || !adminPassword) {
    return Response.json(
      { success: false, errors: ["SYNC_SECRET / ADMIN_PASSWORD sind nicht konfiguriert"] },
      { status: 500 },
    );
  }
  if (!isSameOrigin(req)) {
    return Response.json({ success: false, errors: ["Ungültiger Origin"] }, { status: 403 });
  }
  const valid = await verifySessionToken(readSessionCookie(req), syncSecret, adminPassword);
  if (!valid) {
    return Response.json({ success: false, errors: ["Nicht angemeldet"] }, { status: 401 });
  }
  return null;
}
