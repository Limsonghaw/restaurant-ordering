import { bindings, defineConfig, defineWorker } from "cf/config";

const preview = process.env.RESTAURANT_A1_HYPERDRIVE_ID;
const productionMenu = process.env.RESTAURANT_MENU_HYPERDRIVE_ID;
const productionOrders = process.env.RESTAURANT_ORDER_HYPERDRIVE_ID;

if (preview && (productionMenu || productionOrders)) {
  throw new Error("The A1 preview cannot use production Hyperdrive bindings.");
}

const menuHyperdrive = preview || productionMenu;

export default defineConfig({
  worker: defineWorker({
    name: preview ? "restaurant-a1-app-preview" : "songhaw-ordering",
    entrypoint: preview
      ? "./workers/a1-preview.ts"
      : productionMenu || productionOrders
        ? "./workers/production-menu.ts"
        : "vinext/server/fetch-handler",
    compatibilityDate: "2026-11-16",
    assets: {
      htmlHandling: "none",
      notFoundHandling: "none",
      runWorkerFirst: ["/*", "!/_next/static/*", "!/*/_next/static/*"],
    },
    env: {
      ...(menuHyperdrive
        ? { HYPERDRIVE: bindings.hyperdrive({ id: menuHyperdrive }) }
        : {}),
      ...(productionOrders
        ? { ORDER_HYPERDRIVE: bindings.hyperdrive({ id: productionOrders }) }
        : {}),
      ASSETS: bindings.assets(),
      CUSTOMER_DB_SSL: bindings.text("require"),
      DEPLOYMENT_PLATFORM: bindings.text("cloudflare"),
      LOCAL_MEMORY_RATE_LIMIT: bindings.text("0"),
      NEXT_PUBLIC_AUTH_SMS_ALLOWED_COUNTRIES: bindings.text("MY"),
      NEXT_PUBLIC_DATA_SOURCE: bindings.text("supabase"),
      NEXT_PUBLIC_SITE_URL: bindings.text(
        "https://songhaw-ordering.s020611h.workers.dev",
      ),
      NEXT_PUBLIC_SUPABASE_URL: bindings.text(
        "https://rdhnbiualjuujveawfxb.supabase.co",
      ),
      NODE_ENV: bindings.text("production"),
    },
  }),
});
