import { describe, expect, it } from "vitest";
import { createSessionToken, isSameOrigin, verifySessionToken } from "@/lib/security/session";

const req = (headers: Record<string, string>) =>
  new Request("https://example.com/api/admin/run", { method: "POST", headers });

describe("isSameOrigin", () => {
  it("akzeptiert Origin, der dem Host entspricht", () => {
    expect(isSameOrigin(req({ origin: "https://site.tld", host: "site.tld" }))).toBe(true);
  });

  it("akzeptiert Origin über X-Forwarded-Host (Proxy wie Webflow Cloud)", () => {
    expect(
      isSameOrigin(
        req({
          origin: "https://site.webflow.io",
          host: "worker.internal",
          "x-forwarded-host": "site.webflow.io",
        }),
      ),
    ).toBe(true);
  });

  it("lehnt fremde Origins und fehlenden Origin ab", () => {
    expect(isSameOrigin(req({ origin: "https://evil.tld", host: "site.tld" }))).toBe(false);
    expect(isSameOrigin(req({ host: "site.tld" }))).toBe(false);
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
