import { Redactor, nullRedactor } from "@/lib/security/redact";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  readonly runId: string;
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

export function newRunId(): string {
  return crypto.randomUUID();
}

/**
 * Strukturierter JSON-Logger. Jede Zeile enthält runId; alle Werte laufen
 * durch den Redactor, damit niemals Secrets in Logs landen.
 */
export function createLogger(
  runId: string,
  redactor: Redactor = nullRedactor,
  context: Record<string, unknown> = {},
): Logger {
  const emit = (level: LogLevel, msg: string, meta?: Record<string, unknown>) => {
    const line = {
      ts: new Date().toISOString(),
      level,
      runId,
      msg: redactor.redactString(msg),
      ...(redactor.redact({ ...context, ...meta }) as Record<string, unknown>),
    };
    const serialized = JSON.stringify(line);
    if (level === "error") console.error(serialized);
    else if (level === "warn") console.warn(serialized);
    else console.log(serialized);
  };

  return {
    runId,
    debug: (msg, meta) => emit("debug", msg, meta),
    info: (msg, meta) => emit("info", msg, meta),
    warn: (msg, meta) => emit("warn", msg, meta),
    error: (msg, meta) => emit("error", msg, meta),
    child: (childContext) => createLogger(runId, redactor, { ...context, ...childContext }),
  };
}
