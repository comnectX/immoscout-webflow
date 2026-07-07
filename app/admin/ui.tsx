"use client";

import { useCallback, useEffect, useState } from "react";

// basePath zur Laufzeit aus der eigenen URL ableiten: Die Admin-Seite liegt
// unter `${basePath}/admin`, unabhängig davon, unter welchem Mount-Path die
// App deployt ist. (Build-zeitige Env-Inlining-Werte überlebt der
// Webflow-Cloud-Builder nicht zuverlässig.)
function basePath(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.replace(/\/admin\/?(?:[?#].*)?$/, "");
}

async function postJson(path: string, body: unknown): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${basePath()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  const data: unknown = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// ── Login ─────────────────────────────────────────────────────────────────────

export function LoginForm() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { status } = await postJson("/api/admin/login", { password });
      if (status === 200) {
        // Passwort verlässt den State sofort; nichts landet in local/sessionStorage.
        setPassword("");
        window.location.reload();
      } else {
        setError(status === 401 ? "Falsches Passwort." : `Anmeldung fehlgeschlagen (HTTP ${status}).`);
      }
    } catch {
      setError("Netzwerkfehler bei der Anmeldung.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>Anmeldung</h2>
      <form onSubmit={submit}>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Admin-Passwort"
          autoComplete="current-password"
          autoFocus
        />
        <button type="submit" disabled={busy || password.length === 0}>
          {busy ? "Anmelden…" : "Anmelden"}
        </button>
      </form>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

interface StatusResponse {
  success?: boolean;
  envPresence?: Record<string, boolean>;
  defaults?: { dryRun?: boolean; syncImages?: boolean; inactiveAction?: string; publishChannel?: string };
}

interface ReportLike {
  success?: boolean;
  dryRun?: boolean;
  runId?: string;
  sourceCount?: number;
  existingWebflowCount?: number;
  createCount?: number;
  updateCount?: number;
  unchangedCount?: number;
  unpublishCount?: number;
  durationMs?: number;
  warnings?: string[];
  errors?: string[];
  checks?: Array<{ check: string; ok: boolean; message: string }>;
}

type Action = "diagnostics" | "dryRun" | "sync";

const ACTION_LABEL: Record<Action, string> = {
  diagnostics: "Verbindungen testen",
  dryRun: "Dry Run starten",
  sync: "Jetzt synchronisieren",
};

export function AdminPanel() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [busyAction, setBusyAction] = useState<Action | null>(null);
  const [lastAction, setLastAction] = useState<string | null>(null);
  const [result, setResult] = useState<ReportLike | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch(`${basePath()}/api/admin/status`, { credentials: "same-origin" });
      if (res.status === 401) {
        window.location.reload();
        return;
      }
      setStatus((await res.json()) as StatusResponse);
    } catch {
      setError("Konfigurationsstatus konnte nicht geladen werden.");
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const run = async (action: Action) => {
    if (action === "sync") {
      const ok = window.confirm(
        "Echten Sync starten? Es werden Items in Webflow erstellt, aktualisiert und ggf. unveröffentlicht.",
      );
      if (!ok) return;
    }
    setBusyAction(action);
    setError(null);
    setResult(null);
    setLastAction(ACTION_LABEL[action]);
    try {
      const { status: httpStatus, data } = await postJson("/api/admin/run", { action });
      if (httpStatus === 401) {
        window.location.reload();
        return;
      }
      setResult(data as ReportLike);
      if (httpStatus >= 500) setError(`Der Lauf meldete Fehler (HTTP ${httpStatus}) — Details unten.`);
    } catch {
      setError("Netzwerkfehler — der Lauf könnte serverseitig noch laufen.");
    } finally {
      setBusyAction(null);
    }
  };

  const logout = async () => {
    await postJson("/api/admin/logout", {});
    window.location.reload();
  };

  const report = result;
  const isReport = report && typeof report.sourceCount === "number";

  return (
    <>
      <div className="card">
        <h2>Konfigurationsstatus</h2>
        {status?.envPresence ? (
          <>
            <div>
              {Object.entries(status.envPresence).map(([key, present]) => (
                <span key={key} className={`badge ${present ? "ok" : "missing"}`}>
                  {key}: {present ? "gesetzt" : "fehlt"}
                </span>
              ))}
            </div>
            {status.defaults && (
              <p className="subtitle" style={{ marginTop: "0.75rem", marginBottom: 0 }}>
                Defaults: DRY_RUN={String(status.defaults.dryRun)} · SYNC_IMAGES=
                {String(status.defaults.syncImages)} · INACTIVE_ACTION={status.defaults.inactiveAction} ·
                Channel={status.defaults.publishChannel}
              </p>
            )}
          </>
        ) : (
          <p>Lade…</p>
        )}
      </div>

      <div className="card">
        <h2>Aktionen</h2>
        {(Object.keys(ACTION_LABEL) as Action[]).map((action) => (
          <button
            key={action}
            className={action === "sync" ? undefined : "secondary"}
            disabled={busyAction !== null}
            onClick={() => void run(action)}
          >
            {busyAction === action ? "Läuft…" : ACTION_LABEL[action]}
          </button>
        ))}
        <button className="danger" onClick={() => void logout()} disabled={busyAction !== null}>
          Abmelden
        </button>
        {error && <p className="error-text">{error}</p>}
      </div>

      {report && (
        <div className="card">
          <h2>
            Ergebnis{lastAction ? ` — ${lastAction}` : ""}
            {report.runId ? ` (Run ${report.runId.slice(0, 8)})` : ""}
          </h2>

          {isReport && (
            <table className="stats">
              <tbody>
                <tr><td>Erfolgreich</td><td>{report.success ? "ja" : "nein"}</td></tr>
                <tr><td>Dry Run</td><td>{report.dryRun ? "ja" : "nein"}</td></tr>
                <tr><td>Inserate bei ImmoScout24</td><td>{report.sourceCount}</td></tr>
                <tr><td>Vorhandene Webflow-Items</td><td>{report.existingWebflowCount}</td></tr>
                <tr><td>Neu angelegt</td><td>{report.createCount}</td></tr>
                <tr><td>Aktualisiert</td><td>{report.updateCount}</td></tr>
                <tr><td>Unverändert</td><td>{report.unchangedCount}</td></tr>
                <tr><td>Unveröffentlicht</td><td>{report.unpublishCount}</td></tr>
                <tr><td>Dauer</td><td>{report.durationMs} ms</td></tr>
              </tbody>
            </table>
          )}

          {report.checks && (
            <ul className="messages">
              {report.checks.map((c) => (
                <li key={c.check} className={c.ok ? undefined : "error-text"}>
                  {c.ok ? "✓" : "✗"} {c.check}: {c.message}
                </li>
              ))}
            </ul>
          )}

          {report.warnings && report.warnings.length > 0 && (
            <>
              <h2 style={{ marginTop: "1rem" }}>Warnungen ({report.warnings.length})</h2>
              <ul className="messages warn">
                {report.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </>
          )}

          {report.errors && report.errors.length > 0 && (
            <>
              <h2 style={{ marginTop: "1rem" }}>Fehler ({report.errors.length})</h2>
              <ul className="messages error">
                {report.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </>
          )}

          <h2 style={{ marginTop: "1rem" }}>Rohantwort</h2>
          <pre className="result">{JSON.stringify(report, null, 2)}</pre>
        </div>
      )}
    </>
  );
}
