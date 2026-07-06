import { Logger } from "@/lib/log";

export interface RetryOptions {
  /** Maximale Versuche insgesamt (Default 3). */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  logger?: Logger;
  /** Beschreibung fürs Log, z. B. "is24 GET /realestate". */
  label?: string;
}

const RETRYABLE = (status: number) => status === 429 || (status >= 500 && status <= 599);

export function parseRetryAfterMs(res: Response): number | undefined {
  const header = res.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch mit Retries für 429/5xx und Netzwerkfehler.
 * Exponentielles Backoff mit Jitter, Retry-After wird respektiert.
 * 400/401/403 werden niemals wiederholt.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: RetryOptions = {},
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const base = opts.baseDelayMs ?? 500;
  const maxDelay = opts.maxDelayMs ?? 15_000;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response | undefined;
    try {
      res = await fetch(url, init);
    } catch (err) {
      lastError = err;
    }

    if (res) {
      if (!RETRYABLE(res.status)) return res;
      lastError = new Error(`HTTP ${res.status}`);
      if (attempt === maxAttempts) return res;
      const retryAfter = parseRetryAfterMs(res);
      // Body verwerfen, damit die Verbindung freigegeben wird.
      await res.body?.cancel().catch(() => undefined);
      const backoff = Math.min(maxDelay, base * 2 ** (attempt - 1));
      const jitter = backoff * (0.5 + Math.random());
      const delay = Math.min(maxDelay, Math.max(retryAfter ?? 0, jitter));
      opts.logger?.warn(`Retry ${attempt}/${maxAttempts - 1} nach HTTP ${res.status}`, {
        label: opts.label,
        delayMs: Math.round(delay),
      });
      await sleep(delay);
      continue;
    }

    if (attempt === maxAttempts) break;
    const backoff = Math.min(maxDelay, base * 2 ** (attempt - 1)) * (0.5 + Math.random());
    opts.logger?.warn(`Retry ${attempt}/${maxAttempts - 1} nach Netzwerkfehler`, {
      label: opts.label,
      delayMs: Math.round(backoff),
    });
    await sleep(backoff);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
