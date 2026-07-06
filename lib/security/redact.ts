/**
 * Entfernt Secrets aus beliebigen Log-/Report-Strukturen, bevor sie
 * ausgegeben werden. Zwei Mechanismen:
 *  1. Wertbasiert: alle bekannten Secret-Werte werden durch [REDACTED] ersetzt.
 *  2. Schlüsselbasiert: Felder wie authorization, password, token usw. werden
 *     unabhängig vom Wert maskiert.
 */

const MASK = "[REDACTED]";

const SENSITIVE_KEY_PATTERN =
  /(authorization|password|passwort|secret|token|api[_-]?key|cookie|set-cookie|signature)/i;

/** Maskiert u. a. "oauth_signature=..." und "Bearer ..." in freien Strings. */
const SENSITIVE_STRING_PATTERNS: Array<[RegExp, string]> = [
  [/(oauth_(?:signature|token|consumer_key)=")[^"]*(")/gi, `$1${MASK}$2`],
  [/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/g, `$1${MASK}`],
];

export class Redactor {
  private readonly secrets: string[];

  constructor(secrets: Array<string | undefined | null>) {
    // Nur nicht-triviale Werte maskieren, sonst zerstören wir normale Strings.
    this.secrets = secrets
      .filter((s): s is string => typeof s === "string" && s.length >= 6)
      .sort((a, b) => b.length - a.length);
  }

  redactString(input: string): string {
    let out = input;
    for (const secret of this.secrets) {
      out = out.split(secret).join(MASK);
    }
    for (const [pattern, replacement] of SENSITIVE_STRING_PATTERNS) {
      out = out.replace(pattern, replacement);
    }
    return out;
  }

  redact(value: unknown, depth = 0): unknown {
    if (depth > 8) return "[TRUNCATED]";
    if (typeof value === "string") return this.redactString(value);
    if (value instanceof Error) {
      return {
        name: value.name,
        message: this.redactString(value.message),
        code: (value as { code?: string }).code,
      };
    }
    if (Array.isArray(value)) return value.map((v) => this.redact(v, depth + 1));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = SENSITIVE_KEY_PATTERN.test(k) ? MASK : this.redact(v, depth + 1);
      }
      return out;
    }
    return value;
  }
}

export const nullRedactor = new Redactor([]);
