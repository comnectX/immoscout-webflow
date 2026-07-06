import { isProduction } from "@/app/api/admin/_lib";
import { clearSessionCookieHeader, isSameOrigin } from "@/lib/security/session";

/** POST /api/admin/logout — löscht das Session-Cookie. */
export async function POST(req: Request): Promise<Response> {
  if (!isSameOrigin(req)) {
    return Response.json({ success: false, errors: ["Ungültiger Origin"] }, { status: 403 });
  }
  return Response.json(
    { success: true },
    { headers: { "Set-Cookie": clearSessionCookieHeader(isProduction()) } },
  );
}
