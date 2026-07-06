# IS24 → Webflow Sync

Produktionsfähige Webflow-Cloud-Anwendung, die eigene Immobilieninserate regelmäßig aus der **ImmoScout24-API** abruft und **einseitig** in eine bestehende **Webflow-CMS-Collection** synchronisiert.

```
ImmoScout24 API  ──▶  Webflow-Cloud-App (Next.js auf Cloudflare Workers)  ──▶  Webflow CMS
   (Source of Truth)        OAuth 1.0a · Normalisierung · Diff/Hash            Staged Items + Item-Publish
```

## Architekturübersicht

| Modul | Aufgabe |
|---|---|
| `lib/config.ts` | Laufzeit-Konfiguration (Zod), niemals build-zeitig |
| `lib/is24/oauth.ts` | OAuth 1.0a / HMAC-SHA1 mit Web Crypto (Edge-kompatibel) |
| `lib/is24/client.ts` | IS24-REST-Client: Liste (paginiert), Details, Anhänge, Bild-Download |
| `lib/is24/normalize.ts` | Normalisierung aller Immobilientypen → `NormalizedListing` |
| `lib/webflow/client.ts` | Webflow Data API v2: Staged Items, Batch-Writes (max. 100), Item-Publish, Assets |
| `lib/webflow/schema.ts` | Schema-Abgleich + Feld-Mapping (`WEBFLOW_FIELD_MAP_JSON`-Override) |
| `lib/webflow/mapper.ts` | `NormalizedListing` → `fieldData` (typkorrekt, sanitisiert, nur gemappte Felder) |
| `lib/webflow/assets.ts` | Bild-Pipeline: Download → Validierung → MD5 → deduplizierter Asset-Upload |
| `lib/sync/engine.ts` | Sync-Ablauf, Diff über SHA-256-Hash, Unpublish-Sicherheitsregel |
| `lib/sync/report.ts` | Strukturierter Sync-Bericht |
| `lib/security/session.ts` | Signierte HttpOnly-Sessions (Web Crypto), Origin-Prüfung |
| `lib/security/redact.ts` | Secret-Redaktion in allen Logs und Fehlermeldungen |
| `app/api/*` | `/api/health`, `/api/diagnostics`, `/api/sync`, Admin-Routen |
| `app/admin` | Deutschsprachige Admin-Oberfläche |
| `.github/workflows/is24-sync.yml` | Scheduler (alle 3 Stunden, Minute 17) |

**Grundprinzipien**

- **Einseitig:** Es wird niemals etwas zurück zu ImmoScout24 geschrieben.
- **Primärschlüssel:** ausschließlich die ImmoScout-ID (`is24-id`). Items ohne `is24-id` (manuell erstellte) werden **niemals** angefasst.
- **Reihenfolge:** erst alle Lesezugriffe (Schema, CMS-Items, kompletter IS24-Abruf), dann Diff, dann Writes. Scheitert der Quell-Abruf, wurde noch nichts geschrieben.
- **Idempotent:** pro Inserat wird ein stabiler SHA-256-Hash gespeichert (`sync-hash`). Unveränderte Inserate erzeugen keine Updates, keine Publishes, keine Asset-Uploads, keine Duplikate.
- **Unpublish-Sicherheitsregel:** Nicht mehr vorhandene Inserate werden nur unveröffentlicht (nie gelöscht), und **nur** wenn der IS24-Abruf nachweislich vollständig und fehlerfrei war (alle Seiten geladen, keine 401/403/429/5xx, keine Detail-/Parsingfehler). Andernfalls wird das Unpublishing für diesen Lauf ausgesetzt und im Bericht gemeldet.

---

## 1. ImmoScout24 einrichten

### Benötigte Berechtigungen

Die App nutzt die **Offer-API** (`/offer/v1.0/user/{username}/realestate`) rein lesend:

- Lesezugriff auf die eigenen Inserate (Liste + Details)
- Lesezugriff auf Anhänge (Bilder)
- Berechtigung für den Abruf per `publishchannel`

> **Hinweis zu `IS24_PUBLISH_CHANNEL`:** Standard ist `Homepage` (Inserate, die für die eigene Website freigegeben sind). Abhängig von den API-Berechtigungen Ihres ImmoScout24-Accounts kann stattdessen `IS24` nötig/erlaubt sein (alle auf ImmoScout24 veröffentlichten Inserate). Wenn `/api/diagnostics` einen 403 für die Inseratsliste meldet, testen Sie den jeweils anderen Wert.

### Persönlichen Access Token erstellen

1. Registrieren Sie sich im [ImmoScout24 API-Portal](https://api.immobilienscout24.de/) und legen Sie eine Anwendung an → Sie erhalten **Consumer Key** und **Consumer Secret**.
2. Beantragen Sie die Freischaltung für die Offer-API (Import/Export) für Ihren Maklerbestand.
3. Erzeugen Sie für Ihren Account ein dauerhaftes **Access Token + Token Secret** (Three-Legged-OAuth einmalig durchlaufen; das Portal bzw. der IS24-Support stellt dafür Werkzeuge bereit).
4. Notieren Sie alle vier Werte — sie kommen später als geheime Umgebungsvariablen in Webflow Cloud, **nirgendwo sonst**.

`IS24_USERNAME` bleibt in der Regel `me` (der zum Token gehörende Account).

## 2. Webflow einrichten

### API-Token

1. Webflow → **Site Settings → Apps & Integrations → API Access → Generate API token**.
2. Benötigte Scopes:
   - **CMS: Read & Write** (immer)
   - **Assets: Read & Write** (nur bei `SYNC_IMAGES=true`)
   - **Sites: Read** (für den Diagnose-Check der Site)

### Site-ID und Collection-ID ermitteln

- **Site-ID:** Site Settings → General → im Abschnitt „Site ID“, oder via API: `GET https://api.webflow.com/v2/sites`.
- **Collection-ID:** CMS → Collection öffnen → Collection Settings; die ID steht in der URL bzw. via API: `GET https://api.webflow.com/v2/sites/{siteId}/collections`.

### CMS-Collection vorbereiten

Die Collection **muss bereits existieren** — die App legt niemals Collections oder Felder an, um oder löscht sie. Beim Start jeder Synchronisierung wird das Schema geladen und geprüft.

**Zwingend erforderlich** (sonst bricht der Sync vor allen Writes mit Diagnose ab):

| Feld-Slug | Typ |
|---|---|
| `name` | Name (Standard) |
| `slug` | Slug (Standard) |
| `is24-id` | Plain Text |

**Empfohlen / optional** (fehlende Felder werden mit Warnung übersprungen):

`external-id`, `sync-hash` *(dringend empfohlen — ohne dieses Feld wird jedes Inserat bei jedem Lauf neu geschrieben)*, `status`, `objektart`, `vermarktungsart`, `preis` (Number), `waehrung`, `wohnflaeche` (Number), `nutzflaeche` (Number), `grundstuecksflaeche` (Number), `zimmer` (Number), `schlafzimmer` (Number), `badezimmer` (Number), `etage` (Number), `baujahr` (Number), `strasse`, `hausnummer`, `plz`, `ort`, `region`, `land`, `latitude` (Number), `longitude` (Number), `kurzbeschreibung`, `beschreibung` (Rich Text), `ausstattung` (Rich Text), `lage` (Rich Text), `energieausweis`, `hauptbild` (Image), `bilder` (Multi-Image), `expose-url` (Link), `is24-modified-at` (Date), `last-synced-at` (Date)

### Feld-Mapping konfigurieren

Das Standard-Mapping (internes Modell → Feld-Slug) ist in `lib/webflow/schema.ts` dokumentiert. Abweichende Slugs überschreiben Sie **partiell** per `WEBFLOW_FIELD_MAP_JSON`, z. B.:

```json
{ "id": "scout-id", "price": "kaufpreis" }
```

Nicht gemappte Webflow-Felder (z. B. manuell gepflegte Texte) werden von Updates **nie** berührt.

## 3. Deployment auf Webflow Cloud

1. Repository zu GitHub pushen.
2. Webflow → **Site Settings → Webflow Cloud** → App anlegen, GitHub-Repo verbinden, Mount-Path wählen (z. B. `/app`).
3. **Wichtig:** Build-Variable `BASE_PATH` auf den Mount-Path setzen (muss übereinstimmen, siehe `next.config.mjs`).
4. Alle Environment Variables anlegen (siehe `.env.example`). **Als Secret markieren:** `WEBFLOW_API_TOKEN`, `IS24_CONSUMER_KEY`, `IS24_CONSUMER_SECRET`, `IS24_ACCESS_TOKEN`, `IS24_ACCESS_TOKEN_SECRET`, `SYNC_SECRET`, `ADMIN_PASSWORD`.
   - `SYNC_SECRET`: langer Zufallswert, z. B. `openssl rand -hex 32`
   - **`DRY_RUN=true` für die erste Inbetriebnahme!**
5. Deployen.

Lokal entwickeln: `.env.example` → `.env` kopieren, `npm install`, `npm run dev`. Worker-Preview: `npm run preview`.

## 4. Inbetriebnahme (empfohlene Reihenfolge)

1. **`DRY_RUN=true` lassen.**
2. **Diagnose:**
   ```bash
   curl --fail-with-body -X POST "https://IHRE-DOMAIN/app/api/diagnostics" \
     -H "Authorization: Bearer $SYNC_SECRET" | jq .
   ```
   Prüft Umgebungsvariablen, Webflow-Verbindung, Collection-Schema/Mapping und IS24-Authentifizierung — ohne Schreiboperationen. Alternativ: Admin-UI → „Verbindungen testen“.
3. **Erster Dry Run** (liest alles, schreibt nichts):
   ```bash
   curl --fail-with-body -X POST "https://IHRE-DOMAIN/app/api/sync?dryRun=true" \
     -H "Authorization: Bearer $SYNC_SECRET" | jq .
   ```
   Bericht prüfen: `createCount`/`updateCount`/`wouldUnpublish` plausibel? Warnungen zu fehlenden Feldern akzeptabel?
4. **Erster echter Sync:** Admin-UI → „Jetzt synchronisieren“ (erzwingt einen echten Lauf), oder `?dryRun=false` an den Sync-Endpunkt. Ergebnis im Webflow CMS kontrollieren.
5. **`DRY_RUN=false` setzen** und neu deployen, damit auch der Scheduler echte Läufe ausführt.
6. **GitHub Secrets** im Repo anlegen:
   - `WEBFLOW_SYNC_URL` = `https://IHRE-DOMAIN/app/api/sync`
   - `WEBFLOW_SYNC_SECRET` = Wert von `SYNC_SECRET`
7. **Zeitplan aktiv:** Der Workflow `.github/workflows/is24-sync.yml` läuft automatisch alle 3 Stunden (Minute 17, vermeidet Lastspitzen) und kann per **Actions → IS24 → Webflow Sync → Run workflow** manuell (auch als Dry Run) gestartet werden.

## 5. API-Referenz

| Route | Methode | Auth | Zweck |
|---|---|---|---|
| `/api/health` | GET | keine | `{ status, version, timestamp }` — keine Secrets, keine externen Aufrufe |
| `/api/diagnostics` | POST | `Bearer SYNC_SECRET` | Konfigurations- und Verbindungs-Checks, rein lesend |
| `/api/sync` | POST | `Bearer SYNC_SECRET` | Synchronisierung. Query: `dryRun=true\|false`, `syncImages=true\|false`, `inactiveAction=unpublish\|ignore` |
| `/api/sync` | GET | — | 405 — ein GET startet **niemals** einen Sync |
| `/admin` | Browser | `ADMIN_PASSWORD` → HttpOnly-Session-Cookie (SameSite=Strict, signiert, 8 h) | Admin-Oberfläche |

Jede Antwort enthält eine zufällige `runId`, die in allen strukturierten Logzeilen des Laufs wiederkehrt.

**Beispiel-Bericht (Dry Run):**

```json
{
  "success": true, "dryRun": true, "runId": "…",
  "sourceCount": 12, "existingWebflowCount": 10,
  "createCount": 2, "updateCount": 3, "unchangedCount": 5,
  "unpublishCount": 0, "warningCount": 1, "errorCount": 0,
  "durationMs": 1234,
  "created": [], "updated": [], "unchanged": [],
  "wouldUnpublish": [], "unpublished": [],
  "warnings": [], "errors": []
}
```

## 6. Bildsynchronisierung

Bei `SYNC_IMAGES=true` werden ausschließlich Bild-Anhänge übernommen (keine PDFs, Videos, Links), in IS24-Reihenfolge; das erste gültige Bild wird `hauptbild`, alle gültigen `bilder`. Alt-Texte entstehen aus Bildtitel bzw. Inseratstitel + Position.

Pipeline pro Bild (nur für neue/geänderte Inserate — unveränderte lösen keine Downloads/Uploads aus):

1. Download (öffentlich; bei 401/403 erneut OAuth-signiert)
2. MIME-Type- und Größen-Validierung — **Bilder > 4 MB werden übersprungen** und im Bericht als Warnung geführt; das Inserat wird trotzdem synchronisiert
3. Edge-kompatibler **MD5**-Hash (`lib/util/md5.ts`, kein Node-crypto) für die Webflow-Assets-API
4. Dateiname `is24-{listingId}-{attachmentId}-{contentHash}.{ext}`; vor jedem Upload wird geprüft, ob ein Asset mit derselben Identität bzw. demselben Hash bereits existiert → kein Doppel-Upload
5. Upload in die Webflow Assets API (`WEBFLOW_SITE_ID`), die `hostedUrl` landet im CMS

Schlägt ein einzelner Upload fehl, wird das Inserat ohne dieses Bild synchronisiert; andere Inserate laufen weiter.

## 7. Fehlerbehebung

| Symptom | Ursache & Lösung |
|---|---|
| **401 bei IS24** | OAuth-Signatur/Token ungültig. Consumer Key/Secret und Access Token/Secret exakt prüfen (keine Leerzeichen/Zeilenumbrüche). Systemuhr-Drift ist auf Workers kein Thema. Kein automatischer Retry. |
| **403 bei IS24** | Fehlende API-Berechtigung — häufig der `publishchannel`. `IS24_PUBLISH_CHANNEL` zwischen `Homepage` und `IS24` wechseln; ggf. Offer-API-Freischaltung beim IS24-Support prüfen. |
| **401 bei Webflow** | Token abgelaufen/widerrufen oder falsche Site. Neues Token mit den o. g. Scopes erzeugen. |
| **403 bei Webflow** | Scopes fehlen (CMS R/W; Assets R/W bei Bildsync) oder Token gehört zu einer anderen Site/Workspace. |
| **429 (beide APIs)** | Rate-Limit. Die App wiederholt automatisch (max. 3 Versuche, exponentielles Backoff mit Jitter, `Retry-After` wird beachtet). Bei Dauer-429: `MAX_CONCURRENCY` senken, Sync-Intervall vergrößern. |
| **„Pflichtfeld … fehlt in der Collection“** | `is24-id`, `name` oder `slug` fehlt → Feld in der Collection anlegen (Slug exakt) oder Mapping per `WEBFLOW_FIELD_MAP_JSON` auf den vorhandenen Slug zeigen lassen. Der Sync bricht in diesem Fall bewusst vor allen Writes ab. |
| **Warnung „Optionales Feld … existiert nicht“** | Unkritisch — Feld anlegen oder Warnung ignorieren; der Rest synchronisiert normal. |
| **Warnung „sync-hash fehlt“** | Änderungserkennung deaktiviert → jedes Inserat wird jedes Mal geschrieben. `sync-hash` (Plain Text) anlegen. |
| **Unpublishing passiert nicht** | Sicherheitsregel: Der letzte IS24-Abruf war nicht vollständig fehlerfrei (siehe `warnings`/`errors` im Bericht). Ursache beheben; beim nächsten fehlerfreien Lauf wird nachgeholt. |
| **Duplikat-Warnung** | Mehrere CMS-Items tragen dieselbe `is24-id` (z. B. manuell dupliziert). Überzählige Items manuell löschen/leeren — die App verändert in diesem Fall bewusst nur das erste. |

## 8. Sicherheit

- Alle Tokens/Secrets existieren nur als (geheime) Webflow-Cloud-Umgebungsvariablen und werden zur **Laufzeit** gelesen — nie im Build, nie im Client-Bundle, nie in Responses.
- Strukturierte Logs laufen durch eine Redaktionsschicht (`lib/security/redact.ts`): bekannte Secret-Werte, `Authorization`-Header, `oauth_signature` u. ä. werden maskiert.
- Admin-Sessions: HMAC-signierte, zeitlich begrenzte HttpOnly-Cookies (SameSite=Strict, Secure in Produktion), Origin-Prüfung auf allen schreibenden Admin-Routen, kein Passwort/Token im Browser-Storage.
- `/api/sync` und `/api/diagnostics` verlangen `Authorization: Bearer SYNC_SECRET` (zeitkonstanter Vergleich).
- Die GitHub Action gibt das Secret niemals aus (nur als Header verwendet; GitHub maskiert Secrets zusätzlich).

## 9. Entwicklung & Tests

```bash
npm install
npm test          # 53 Unit-Tests (OAuth-Signatur, Slugs, Normalisierung, Mapping,
                  # Hashing, Dry-Run, Idempotenz, Duplikatschutz, Unpublish-Sicherheitsregel, Redaktion)
npm run typecheck # striktes TypeScript
npm run build     # Next.js-Produktionsbuild
npm run preview   # OpenNext-Cloudflare-Build + lokale Worker-Preview
```
