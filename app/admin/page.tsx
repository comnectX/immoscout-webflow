import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/security/session";
import { AdminPanel, LoginForm } from "./ui";

// Session/Env dürfen nur zur Laufzeit gelesen werden — niemals beim Build.
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const syncSecret = process.env.SYNC_SECRET;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!syncSecret || !adminPassword) {
    return (
      <main>
        <h1>IS24 → Webflow Synchronisierung</h1>
        <p className="subtitle">Verwaltung der Immobilien-Synchronisierung</p>
        <div className="card">
          <p className="error-text">
            SYNC_SECRET und ADMIN_PASSWORD sind nicht konfiguriert. Bitte die
            Umgebungsvariablen in Webflow Cloud setzen und neu deployen.
          </p>
        </div>
      </main>
    );
  }

  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  const loggedIn = await verifySessionToken(token, syncSecret, adminPassword);

  return (
    <main>
      <h1>IS24 → Webflow Synchronisierung</h1>
      <p className="subtitle">Verwaltung der Immobilien-Synchronisierung</p>
      {loggedIn ? <AdminPanel /> : <LoginForm />}
    </main>
  );
}
