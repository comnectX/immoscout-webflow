/**
 * Signierte, zeitlich begrenzte Admin-Sessions ohne serverseitigen State.
 * Token-Format: v1.<payload-b64url>.<hmac-sha256-b64url>
 * Signaturschlüssel wird aus SYNC_SECRET + ADMIN_PASSWORD abgeleitet —
 * ein Passwortwechsel invalidiert damit alle Sessions.
 */

export const SESSION_COOKIE = "is24sync_session";
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

interface SessionPayload {
  iat: number;
  exp: number;
}

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(input: string): Uint8Array | null {
  try {
    const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(b64);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function signingKey(syncSecret: string, adminPassword: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`is24sync-session:${syncSecret}:${adminPassword}`),
  );
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function createSessionToken(
  syncSecret: string,
  adminPassword: string,
  nowMs = Date.now(),
): Promise<string> {
  const payload: SessionPayload = {
    iat: Math.floor(nowMs / 1000),
    exp: Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS,
  };
  const payloadB64 = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await signingKey(syncSecret, adminPassword);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(`v1.${payloadB64}`));
  return `v1.${payloadB64}.${toBase64Url(new Uint8Array(sig))}`;
}

export async function verifySessionToken(
  token: string | undefined | null,
  syncSecret: string,
  adminPassword: string,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const [, payloadB64, sigB64] = parts as [string, string, string];
  const sigBytes = fromBase64Url(sigB64);
  const payloadBytes = fromBase64Url(payloadB64);
  if (!sigBytes || !payloadBytes) return false;

  const key = await signingKey(syncSecret, adminPassword);
  // crypto.subtle.verify vergleicht zeitkonstant.
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes.buffer as ArrayBuffer,
    encoder.encode(`v1.${payloadB64}`),
  );
  if (!valid) return false;

  try {
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as SessionPayload;
    return typeof payload.exp === "number" && payload.exp * 1000 > nowMs;
  } catch {
    return false;
  }
}

export function sessionCookieHeader(token: string, secure: boolean): string {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearSessionCookieHeader(secure: boolean): string {
  const attrs = [`${SESSION_COOKIE}=`, "HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

/** Zeitkonstanter String-Vergleich über SHA-256-Digests. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const ba = new Uint8Array(da);
  const bb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < ba.length; i++) diff |= (ba[i] as number) ^ (bb[i] as number);
  return diff === 0;
}

/** Origin-Prüfung für schreibende Browser-Requests (CSRF-Schutz). */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
