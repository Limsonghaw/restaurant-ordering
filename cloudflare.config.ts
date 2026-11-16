import { bindings, defineConfig, defineWorker } from "cf/config";

export default defineConfig({
  worker: defineWorker({
    name: "songhaw-ordering",
    entrypoint: "vinext/server/fetch-handler",
    compatibilityDate: "2026-11-16",
    assets: {
      htmlHandling: "none",
      notFoundHandling: "none",
      runWorkerFirst: ["/*", "!/_next/static/*", "!/*/_next/static/*"],
    },
    env: {
      ASSETS: bindings.assets(),
      CUSTOMER_DB_SSL: bindings.text("require"),
      DEPLOYMENT_PLATFORM: bindings.text("cloudflare"),
      LOCAL_MEMORY_RATE_LIMIT: bindings.text("0"),
      NEXT_PUBLIC_AUTH_SMS_ALLOWED_COUNTRIES: bindings.text("MY"),
      NEXT_PUBLIC_DATA_SOURCE: bindings.text("supabase"),
      NEXT_PUBLIC_SITE_URL: bindings.text(
        "https://songhaw-ordering.s020611h.workers.dev"
      ),
      NEXT_PUBLIC_SUPABASE_URL: bindings.text(
        "https://rdhnbiualjuujveawfxb.supabase.co"
      ),
      NODE_ENV: bindings.text("production"),
    },
  }),
});