import { readSessionCookie } from "@/app/api/admin/_lib";
import { configPresence } from "@/lib/config";
import { verifySessionToken } from "@/lib/security/session";

/**
 * GET /api/admin/status — Konfigurationsstatus für die Admin-UI.
 * Gibt ausschließlich AN/AUS pro Variable zurück, niemals Werte.
 */
export async function GET(req: Request): Promise<Response> {
  const syncSecret = process.env.SYNC_SECRET;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!syncSecret || !adminPassword) {
    return Response.json(
      { success: false, errors: ["SYNC_SECRET / ADMIN_PASSWORD sind nicht konfiguriert"] },
      { status: 500 },
    );
  }
  const valid = await verifySessionToken(readSessionCookie(req), syncSecret, adminPassword);
  if (!valid) {
    return Response.json({ success: false, errors: ["Nicht angemeldet"] }, { status: 401 });
  }

  return Response.json({
    success: true,
    envPresence: configPresence(),
    defaults: {
      dryRun: (process.env.DRY_RUN ?? "true").toLowerCase() !== "false",
      syncImages: (process.env.SYNC_IMAGES ?? "true").toLowerCase() !== "false",
      inactiveAction: process.env.INACTIVE_ACTION?.toLowerCase() === "ignore" ? "ignore" : "unpublish",
      publishChannel: process.env.IS24_PUBLISH_CHANNEL || "Homepage",
    },
  });
}
