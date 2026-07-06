import { describe, expect, it } from "vitest";
import { Redactor } from "@/lib/security/redact";

describe("Redactor", () => {
  const redactor = new Redactor(["super-geheimes-token-123", "webflow-api-key-xyz"]);

  it("ersetzt bekannte Secret-Werte in Strings", () => {
    const input = "Request mit Token super-geheimes-token-123 fehlgeschlagen";
    expect(redactor.redactString(input)).toBe("Request mit Token [REDACTED] fehlgeschlagen");
  });

  it("maskiert sensible Schlüssel unabhängig vom Wert", () => {
    const out = redactor.redact({
      authorization: "Bearer irgendwas",
      Password: "hunter22222",
      nested: { IS24_CONSUMER_SECRET: "abc", safe: "bleibt" },
    }) as Record<string, unknown>;
    expect(out.authorization).toBe("[REDACTED]");
    expect(out.Password).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).IS24_CONSUMER_SECRET).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).safe).toBe("bleibt");
  });

  it("maskiert Bearer-Tokens und oauth_signature in freien Strings", () => {
    expect(redactor.redactString("Authorization: Bearer abc.def-ghi")).toContain("Bearer [REDACTED]");
    expect(redactor.redactString('oauth_signature="tnnArxj06cWHq44gCs1OSKk%2FjLY%3D"')).toBe(
      'oauth_signature="[REDACTED]"',
    );
  });

  it("redigiert rekursiv in Arrays und Fehlern", () => {
    const out = redactor.redact([new Error("Token webflow-api-key-xyz ungültig")]) as Array<{
      message: string;
    }>;
    expect(out[0]?.message).toBe("Token [REDACTED] ungültig");
  });

  it("ignoriert zu kurze Secrets (verhindert Zerstörung normaler Strings)", () => {
    const shortRedactor = new Redactor(["ab", ""]);
    expect(shortRedactor.redactString("abgabe")).toBe("abgabe");
  });
});
