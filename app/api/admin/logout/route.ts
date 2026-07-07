import { isProduction } from "@/app/api/admin/_lib";
import { clearSessionCookieHeader, isTrustedOrigin } from "@/lib/security/session";

/** POST /api/admin/logout — löscht das Session-Cookie. */
export async function POST(req: Request): Promise<Response> {
  if (!isTrustedOrigin(req, process.env.ADMIN_ALLOWED_ORIGINS)) {
    return Response.json({ success: false, errors: ["Ungültiger Origin"] }, { status: 403 });
  }
  return Response.json(
    { success: true },
    { headers: { "Set-Cookie": clearSessionCookieHeader(isProduction()) } },
  );
}
