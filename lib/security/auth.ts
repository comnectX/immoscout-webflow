import { safeEqual } from "@/lib/security/session";

/** Prüft "Authorization: Bearer {SYNC_SECRET}" zeitkonstant. */
export async function checkBearerAuth(req: Request, syncSecret: string): Promise<boolean> {
  const header = req.headers.get("authorization");
  if (!header) return false;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match || !match[1]) return false;
  return safeEqual(match[1], syncSecret);
}

export function unauthorizedResponse(runId: string): Response {
  return Response.json(
    { success: false, runId, errors: ["Nicht autorisiert"] },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  );
}
