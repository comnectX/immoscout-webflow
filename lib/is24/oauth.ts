/**
 * OAuth 1.0a (HMAC-SHA1) für die ImmoScout24-REST-API.
 * Vollständig auf Web-Standards (crypto.subtle) — Edge-kompatibel,
 * keine Node-crypto-Abhängigkeit.
 */

export interface OAuthCredentials {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
}

export interface SignRequestInput {
  method: string;
  /** Vollständige URL inkl. Query-String. */
  url: string;
  credentials: OAuthCredentials;
  /** Zusätzliche Parameter (z. B. form-encodierter Body) für die Signatur. */
  extraParams?: Record<string, string>;
  /** Nur für Tests injizierbar. */
  timestamp?: string;
  nonce?: string;
}

/** Percent-Encoding nach RFC 3986 (strenger als encodeURIComponent). */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

async function hmacSha1Base64(key: string, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
  let binary = "";
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface SignedRequest {
  /** Wert für den Authorization-Header. */
  authorizationHeader: string;
  signature: string;
  signatureBase: string;
}

export async function signOAuthRequest(input: SignRequestInput): Promise<SignedRequest> {
  const url = new URL(input.url);
  const method = input.method.toUpperCase();
  const timestamp = input.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = input.nonce ?? randomNonce();

  const oauthParams: Record<string, string> = {
    oauth_consumer_key: input.credentials.consumerKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: input.credentials.accessToken,
    oauth_version: "1.0",
  };

  // Signatur-Basis: OAuth-Params + Query-Params + ggf. Body-Params,
  // percent-encodiert und nach Key/Value sortiert.
  const allParams: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(oauthParams)) allParams.push([k, v]);
  for (const [k, v] of url.searchParams.entries()) allParams.push([k, v]);
  for (const [k, v] of Object.entries(input.extraParams ?? {})) allParams.push([k, v]);

  const encoded = allParams
    .map(([k, v]) => [percentEncode(k), percentEncode(v)] as const)
    .sort(([ka, va], [kb, vb]) => (ka === kb ? (va < vb ? -1 : 1) : ka < kb ? -1 : 1));
  const paramString = encoded.map(([k, v]) => `${k}=${v}`).join("&");

  const baseUrl = `${url.protocol}//${url.host.toLowerCase()}${url.pathname}`;
  const signatureBase = [method, percentEncode(baseUrl), percentEncode(paramString)].join("&");

  const signingKey = `${percentEncode(input.credentials.consumerSecret)}&${percentEncode(
    input.credentials.accessTokenSecret,
  )}`;
  const signature = await hmacSha1Base64(signingKey, signatureBase);

  const headerParams: Record<string, string> = {
    ...oauthParams,
    oauth_signature: signature,
  };
  const authorizationHeader =
    "OAuth " +
    Object.entries(headerParams)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
      .join(", ");

  return { authorizationHeader, signature, signatureBase };
}
