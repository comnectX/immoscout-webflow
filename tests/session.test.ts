import { describe, expect, it } from "vitest";
import { createSessionToken, isTrustedOrigin, verifySessionToken } from "@/lib/security/session";

const req = (headers: Record<string, string>) =>
  new Request("https://internal.webflow.services/api/admin/run", { method: "POST", headers });

describe("isTrustedOrigin", () => {
  it("akzeptiert Webflow-Domains per Default, auch wenn der Host intern umgeschrieben ist", () => {
    // Genau der Webflow-Cloud-Fall: Origin öffentlich, Host intern.
    expect(
      isTrustedOrigin(req({ origin: "https://neuefinanzkultur-575ede.webflow.io", host: "abc.webflow.services" })),
    ).toBe(true);
  });

  it("lehnt fremde Origins und fehlenden Origin ab", () => {
    expect(isTrustedOrigin(req({ origin: "https://evil.tld" }))).toBe(false);
    expect(isTrustedOrigin(req({ host: "abc.webflow.services" }))).toBe(false);
  });

  it("erzwingt bei konfigurierter Allowlist exakte Host-Übereinstimmung", () => {
    const allow = "https://immobilien.neuefinanzkultur.de";
    expect(isTrustedOrigin(req({ origin: "https://immobilien.neuefinanzkultur.de" }), allow)).toBe(true);
    // Mit gesetzter Allowlist zählt die Default-Webflow-Freigabe nicht mehr.
    expect(isTrustedOrigin(req({ origin: "https://site.webflow.io" }), allow)).toBe(false);
  });

  it("akzeptiert Allowlist-Einträge mit und ohne Schema", () => {
    expect(isTrustedOrigin(req({ origin: "https://a.de" }), "a.de, b.de")).toBe(true);
    expect(isTrustedOrigin(req({ origin: "https://b.de" }), "a.de, b.de")).toBe(true);
    expect(isTrustedOrigin(req({ origin: "https://c.de" }), "a.de, b.de")).toBe(false);
  });
});

describe("Session-Token", () => {
  it("Roundtrip: erstellen und verifizieren", async () => {
    const token = await createSessionToken("sync-secret-123456", "admin-pass");
    expect(await verifySessionToken(token, "sync-secret-123456", "admin-pass")).toBe(true);
  });

  it("lehnt manipulierte, fremde und abgelaufene Tokens ab", async () => {
    const token = await createSessionToken("sync-secret-123456", "admin-pass");
    expect(await verifySessionToken(token + "x", "sync-secret-123456", "admin-pass")).toBe(false);
    expect(await verifySessionToken(token, "anderes-secret-9999", "admin-pass")).toBe(false);
    // Passwortwechsel invalidiert Sessions
    expect(await verifySessionToken(token, "sync-secret-123456", "neues-pass")).toBe(false);
    // abgelaufen: iat weit in der Vergangenheit
    const old = await createSessionToken("sync-secret-123456", "admin-pass", Date.now() - 9 * 60 * 60 * 1000);
    expect(await verifySessionToken(old, "sync-secret-123456", "admin-pass")).toBe(false);
  });
});
