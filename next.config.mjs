// BASE_PATH muss dem Mount-Path der Webflow-Cloud-App entsprechen (z. B. "/app").
// Er ist der einzige build-zeitige Env-Wert; alle Secrets werden ausschließlich
// zur Laufzeit gelesen (siehe lib/config.ts).
const basePath = process.env.BASE_PATH ?? "";

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

// Lokale Entwicklung mit Cloudflare-Bindings (no-op im reinen Next-Build).
try {
  const { initOpenNextCloudflareForDev } = await import("@opennextjs/cloudflare");
  initOpenNextCloudflareForDev();
} catch {
  // @opennextjs/cloudflare ist nur als devDependency vorhanden.
}
