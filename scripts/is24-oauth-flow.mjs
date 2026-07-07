#!/usr/bin/env node
/**
 * Einmaliger OAuth-1.0a-Autorisierungslauf für die ImmoScout24-API.
 * Erzeugt das permanente Access Token + Token Secret für IS24_ACCESS_TOKEN /
 * IS24_ACCESS_TOKEN_SECRET.
 *
 * Verwendung:
 *   1) node scripts/is24-oauth-flow.mjs request [--sandbox]
 *      → gibt eine Bestätigungs-URL aus; im Browser öffnen, als IS24-Nutzer
 *        anmelden und Zugriff bestätigen. Der temporäre Token-State wird in
 *        .is24-oauth-state.json gespeichert (nicht committen).
 *   2) node scripts/is24-oauth-flow.mjs access <oauth_verifier> [--sandbox]
 *      → tauscht den bestätigten Request Token gegen das permanente Access Token.
 *
 * Consumer-Daten werden aus den Env-Variablen IS24_CONSUMER_KEY und
 * IS24_CONSUMER_SECRET gelesen (niemals als CLI-Argument übergeben).
 * Läuft lokal unter Node (node:crypto), nicht in der Edge-Runtime.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".is24-oauth-state.json");

const args = process.argv.slice(2);
const sandbox = args.includes("--sandbox");
const command = args.find((a) => !a.startsWith("--"));
const verifier = args.filter((a) => !a.startsWith("--"))[1];

const HOST = sandbox
  ? "https://rest.sandbox-immobilienscout24.de"
  : "https://rest.immobilienscout24.de";

const CONSUMER_KEY = process.env.IS24_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.IS24_CONSUMER_SECRET;
if (!CONSUMER_KEY || !CONSUMER_SECRET) {
  console.error("Bitte IS24_CONSUMER_KEY und IS24_CONSUMER_SECRET als Env-Variablen setzen.");
  process.exit(1);
}

const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

function sign(method, url, params, tokenSecret = "") {
  const u = new URL(url);
  const all = [...Object.entries(params), ...u.searchParams.entries()]
    .map(([k, v]) => [enc(k), enc(v)])
    .sort(([ka, va], [kb, vb]) => (ka === kb ? va.localeCompare(vb) : ka.localeCompare(kb)))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const base = [method, enc(`${u.protocol}//${u.host}${u.pathname}`), enc(all)].join("&");
  const key = `${enc(CONSUMER_SECRET)}&${enc(tokenSecret)}`;
  return crypto.createHmac("sha1", key).update(base).digest("base64");
}

async function oauthCall(pathname, extraOauth, tokenSecret) {
  const url = `${HOST}${pathname}`;
  const oauth = {
    oauth_consumer_key: CONSUMER_KEY,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: "1.0",
    ...extraOauth,
  };
  oauth.oauth_signature = sign("POST", url, oauth, tokenSecret);
  const header =
    "OAuth " +
    Object.entries(oauth)
      .map(([k, v]) => `${enc(k)}="${enc(v)}"`)
      .join(", ");
  const res = await fetch(url, { method: "POST", headers: { Authorization: header } });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} bei ${pathname}: ${body.slice(0, 300)}`);
  }
  return Object.fromEntries(new URLSearchParams(body));
}

if (command === "request") {
  const result = await oauthCall("/restapi/security/oauth/request_token", {
    oauth_callback: "oob",
  });
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({ sandbox, token: result.oauth_token, secret: result.oauth_token_secret }, null, 2),
    { mode: 0o600 },
  );
  console.log("Request Token erhalten. Jetzt im Browser bestätigen:");
  console.log("");
  console.log(`  ${HOST}/restapi/security/oauth/confirm_access?oauth_token=${encodeURIComponent(result.oauth_token)}`);
  console.log("");
  console.log("Nach der Bestätigung den angezeigten Verifier-Code übergeben:");
  console.log(`  node scripts/is24-oauth-flow.mjs access <verifier>${sandbox ? " --sandbox" : ""}`);
} else if (command === "access") {
  if (!verifier) {
    console.error("Verifier fehlt: node scripts/is24-oauth-flow.mjs access <verifier>");
    process.exit(1);
  }
  const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  if (state.sandbox !== sandbox) {
    console.error("State-Datei stammt aus einer anderen Umgebung (Sandbox/Produktion).");
    process.exit(1);
  }
  const result = await oauthCall(
    "/restapi/security/oauth/access_token",
    { oauth_token: state.token, oauth_verifier: verifier },
    state.secret,
  );
  fs.unlinkSync(STATE_FILE);
  console.log("Permanentes Access Token erstellt. In Webflow Cloud eintragen:");
  console.log("");
  console.log(`  IS24_ACCESS_TOKEN=${result.oauth_token}`);
  console.log(`  IS24_ACCESS_TOKEN_SECRET=${result.oauth_token_secret}`);
} else {
  console.error("Verwendung: node scripts/is24-oauth-flow.mjs <request|access> [verifier] [--sandbox]");
  process.exit(1);
}
