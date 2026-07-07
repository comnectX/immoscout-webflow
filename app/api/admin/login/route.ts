import { isProduction } from "@/app/api/admin/_lib";
import {
  createSessionToken,
  isTrustedOrigin,
  safeEqual,
  sessionCookieHeader,
} from "@/lib/security/session";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** POST /api/admin/login — Body: { password }. Setzt HttpOnly-Session-Cookie. */
export async function POST(req: Request): Promise<Response> {
  const syncSecret = process.env.SYNC_SECRET;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!syncSecret || !adminPassword) {
    return Response.json(
      { success: false, errors: ["SYNC_SECRET / ADMIN_PASSWORD sind nicht konfiguriert"] },
      { status: 500 },
    );
  }
  if (!isTrustedOrigin(req, process.env.ADMIN_ALLOWED_ORIGINS)) {
    return Response.json({ success: false, errors: ["Ungültiger Origin"] }, { status: 403 });
  }

  let password = "";
  try {
    const body = (await req.json()) as { password?: unknown };
    if (typeof body.password === "string") password = body.password;
  } catch {
    // leerer/ungültiger Body → schlägt unten fehl
  }

  if (!password || !(await safeEqual(password, adminPassword))) {
    // Kleine Verzögerung gegen Brute-Force.
    await sleep(750);
    return Response.json({ success: false, errors: ["Falsches Passwort"] }, { status: 401 });
  }

  const token = await createSessionToken(syncSecret, adminPassword);
  return Response.json(
    { success: true },
    { headers: { "Set-Cookie": sessionCookieHeader(token, isProduction()) } },
  );
}
