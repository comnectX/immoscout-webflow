import { z } from "zod";
import { ConfigError } from "@/lib/errors";
import { Redactor } from "@/lib/security/redact";

export type InactiveAction = "unpublish" | "ignore";

export interface AppConfig {
  webflowApiToken: string;
  webflowSiteId: string;
  webflowCollectionId: string;

  is24ConsumerKey: string;
  is24ConsumerSecret: string;
  is24AccessToken: string;
  is24AccessTokenSecret: string;
  is24Username: string;
  is24BaseUrl: string;
  is24PublishChannel: string;

  syncSecret: string;
  adminPassword: string;

  dryRunDefault: boolean;
  syncImagesDefault: boolean;
  inactiveActionDefault: InactiveAction;
  maxConcurrency: number;

  /** Optionales Override des Feld-Mappings (partiell, überschreibt Defaults). */
  fieldMapOverride: Record<string, string> | null;
}

const boolString = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === "") return def;
      return ["true", "1", "yes"].includes(v.trim().toLowerCase());
    });

const envSchema = z.object({
  WEBFLOW_API_TOKEN: z.string().min(1),
  WEBFLOW_SITE_ID: z.string().min(1),
  WEBFLOW_COLLECTION_ID: z.string().min(1),

  IS24_CONSUMER_KEY: z.string().min(1),
  IS24_CONSUMER_SECRET: z.string().min(1),
  IS24_ACCESS_TOKEN: z.string().min(1),
  IS24_ACCESS_TOKEN_SECRET: z.string().min(1),
  IS24_USERNAME: z.string().optional().transform((v) => (v && v.trim() ? v.trim() : "me")),
  IS24_BASE_URL: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim().replace(/\/+$/, "") : "https://rest.immobilienscout24.de/restapi/api")),
  IS24_PUBLISH_CHANNEL: z.string().optional().transform((v) => (v && v.trim() ? v.trim() : "Homepage")),

  SYNC_SECRET: z.string().min(16, "SYNC_SECRET muss mindestens 16 Zeichen lang sein"),
  ADMIN_PASSWORD: z.string().min(8, "ADMIN_PASSWORD muss mindestens 8 Zeichen lang sein"),

  DRY_RUN: boolString(true),
  SYNC_IMAGES: boolString(true),
  INACTIVE_ACTION: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim().toLowerCase() : "unpublish"))
    .pipe(z.enum(["unpublish", "ignore"])),
  MAX_CONCURRENCY: z
    .string()
    .optional()
    .transform((v) => {
      const n = v ? Number.parseInt(v, 10) : 3;
      return Number.isFinite(n) && n >= 1 && n <= 10 ? n : 3;
    }),

  WEBFLOW_FIELD_MAP_JSON: z.string().optional(),
});

/**
 * Liest die Konfiguration ausschließlich zur Laufzeit aus process.env
 * (auf Webflow Cloud / OpenNext wird process.env pro Request befüllt).
 * Niemals auf Modulebene aufrufen.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".") || "?"}: ${i.message}`);
    throw new ConfigError(
      `Ungültige oder fehlende Umgebungsvariablen: ${problems.join("; ")}`,
      { missing: problems },
    );
  }
  const e = parsed.data;

  let fieldMapOverride: Record<string, string> | null = null;
  if (e.WEBFLOW_FIELD_MAP_JSON && e.WEBFLOW_FIELD_MAP_JSON.trim()) {
    try {
      const raw: unknown = JSON.parse(e.WEBFLOW_FIELD_MAP_JSON);
      const map = z.record(z.string(), z.string()).parse(raw);
      fieldMapOverride = map;
    } catch (err) {
      throw new ConfigError(
        "WEBFLOW_FIELD_MAP_JSON ist kein gültiges JSON-Objekt aus String-Paaren",
        { cause: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  return {
    webflowApiToken: e.WEBFLOW_API_TOKEN,
    webflowSiteId: e.WEBFLOW_SITE_ID,
    webflowCollectionId: e.WEBFLOW_COLLECTION_ID,
    is24ConsumerKey: e.IS24_CONSUMER_KEY,
    is24ConsumerSecret: e.IS24_CONSUMER_SECRET,
    is24AccessToken: e.IS24_ACCESS_TOKEN,
    is24AccessTokenSecret: e.IS24_ACCESS_TOKEN_SECRET,
    is24Username: e.IS24_USERNAME,
    is24BaseUrl: e.IS24_BASE_URL,
    is24PublishChannel: e.IS24_PUBLISH_CHANNEL,
    syncSecret: e.SYNC_SECRET,
    adminPassword: e.ADMIN_PASSWORD,
    dryRunDefault: e.DRY_RUN,
    syncImagesDefault: e.SYNC_IMAGES,
    inactiveActionDefault: e.INACTIVE_ACTION,
    maxConcurrency: e.MAX_CONCURRENCY,
    fieldMapOverride,
  };
}

/** Welche Variablen sind gesetzt? Für /api/diagnostics und Admin-UI — ohne Werte. */
export function configPresence(env: Record<string, string | undefined> = process.env) {
  const keys = [
    "WEBFLOW_API_TOKEN",
    "WEBFLOW_SITE_ID",
    "WEBFLOW_COLLECTION_ID",
    "IS24_CONSUMER_KEY",
    "IS24_CONSUMER_SECRET",
    "IS24_ACCESS_TOKEN",
    "IS24_ACCESS_TOKEN_SECRET",
    "IS24_USERNAME",
    "IS24_BASE_URL",
    "IS24_PUBLISH_CHANNEL",
    "SYNC_SECRET",
    "ADMIN_PASSWORD",
    "DRY_RUN",
    "SYNC_IMAGES",
    "INACTIVE_ACTION",
    "MAX_CONCURRENCY",
    "WEBFLOW_FIELD_MAP_JSON",
  ] as const;
  return Object.fromEntries(
    keys.map((k) => [k, Boolean(env[k] && env[k]!.trim().length > 0)]),
  ) as Record<(typeof keys)[number], boolean>;
}

export function redactorFromConfig(cfg: AppConfig): Redactor {
  return new Redactor([
    cfg.webflowApiToken,
    cfg.is24ConsumerKey,
    cfg.is24ConsumerSecret,
    cfg.is24AccessToken,
    cfg.is24AccessTokenSecret,
    cfg.syncSecret,
    cfg.adminPassword,
  ]);
}
