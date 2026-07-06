/**
 * Einheitliche Fehlerklassen. Jede Klasse trägt einen stabilen `code`,
 * optional den HTTP-Status der Ursache und maschinenlesbare Details.
 * Details dürfen niemals Secrets enthalten (siehe lib/security/redact.ts).
 */

export type ErrorCode =
  | "CONFIG_ERROR"
  | "AUTHENTICATION_ERROR"
  | "PERMISSION_ERROR"
  | "RATE_LIMIT_ERROR"
  | "SOURCE_INCOMPLETE"
  | "WEBFLOW_API_ERROR"
  | "IS24_API_ERROR"
  | "MAPPING_ERROR"
  | "ASSET_ERROR";

export class SyncError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    opts?: { status?: number; details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, { cause: opts?.cause });
    this.name = new.target.name;
    this.code = code;
    this.status = opts?.status;
    this.details = opts?.details;
  }
}

export class ConfigError extends SyncError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("CONFIG_ERROR", message, { details });
  }
}

export class AuthenticationError extends SyncError {
  constructor(message: string, opts?: { status?: number; details?: Record<string, unknown> }) {
    super("AUTHENTICATION_ERROR", message, opts);
  }
}

export class PermissionError extends SyncError {
  constructor(message: string, opts?: { status?: number; details?: Record<string, unknown> }) {
    super("PERMISSION_ERROR", message, opts);
  }
}

export class RateLimitError extends SyncError {
  readonly retryAfterMs?: number;
  constructor(message: string, opts?: { status?: number; retryAfterMs?: number }) {
    super("RATE_LIMIT_ERROR", message, { status: opts?.status });
    this.retryAfterMs = opts?.retryAfterMs;
  }
}

/** IS24-Abruf war nicht nachweislich vollständig → Unpublishing verboten. */
export class SourceIncompleteError extends SyncError {
  constructor(message: string, opts?: { cause?: unknown; details?: Record<string, unknown> }) {
    super("SOURCE_INCOMPLETE", message, opts);
  }
}

export class WebflowApiError extends SyncError {
  constructor(message: string, opts?: { status?: number; details?: Record<string, unknown>; cause?: unknown }) {
    super("WEBFLOW_API_ERROR", message, opts);
  }
}

export class Is24ApiError extends SyncError {
  constructor(message: string, opts?: { status?: number; details?: Record<string, unknown>; cause?: unknown }) {
    super("IS24_API_ERROR", message, opts);
  }
}

export class MappingError extends SyncError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("MAPPING_ERROR", message, { details });
  }
}

export class AssetError extends SyncError {
  constructor(message: string, opts?: { status?: number; details?: Record<string, unknown>; cause?: unknown }) {
    super("ASSET_ERROR", message, opts);
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** HTTP-Status → passende Fehlerklasse für eine externe API. */
export function classifyHttpError(
  api: "is24" | "webflow",
  status: number,
  message: string,
  retryAfterMs?: number,
): SyncError {
  if (status === 401) return new AuthenticationError(`${api}: ${message}`, { status });
  if (status === 403) return new PermissionError(`${api}: ${message}`, { status });
  if (status === 429) return new RateLimitError(`${api}: ${message}`, { status, retryAfterMs });
  return api === "is24"
    ? new Is24ApiError(message, { status })
    : new WebflowApiError(message, { status });
}
