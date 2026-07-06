// basePath muss dem Mount-Path der Webflow-Cloud-App entsprechen.
// Der Webflow-Cloud-Builder stellt ihn als COSMIC_MOUNT_PATH bereit;
// BASE_PATH kann ihn explizit überschreiben (z. B. für lokale Builds).
// Es ist der einzige build-zeitige Env-Wert; alle Secrets werden
// ausschließlich zur Laufzeit gelesen (siehe lib/config.ts).
//
// Wichtig: keine top-level awaits in dieser Datei — der Webflow-Cloud-
// Builder lädt sie per require() (ERR_REQUIRE_ASYNC_MODULE).
const basePath = process.env.BASE_PATH ?? process.env.COSMIC_MOUNT_PATH ?? "";

/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath,
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
