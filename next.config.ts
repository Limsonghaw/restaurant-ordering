import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants.js";

const supabaseOrigin = process.env.NEXT_PUBLIC_SUPABASE_URL
  ? new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).origin
  : "https://*.supabase.co";
const csp = [
  "default-src 'self'",
  // Next.js hydration uses inline scripts; development also needs eval.
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""} https://challenges.cloudflare.com`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${supabaseOrigin}`,
  "font-src 'self'",
  `connect-src 'self' ${supabaseOrigin} ${supabaseOrigin.replace(/^https:/, "wss:").replace(/^http:/, "ws:")}`,
  "frame-src https://challenges.cloudflare.com",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};
export default function config(phase: string): NextConfig {
  const dataSource = process.env.NEXT_PUBLIC_DATA_SOURCE;
  if (dataSource !== "mock" && dataSource !== "supabase") {
    throw new Error("NEXT_PUBLIC_DATA_SOURCE 必须明确设置为 mock 或 supabase");
  }
  const environment = (process.env.VERCEL_ENV ?? "").trim().toLowerCase();
  const isPreview = process.env.VERCEL === "1" && environment === "preview";
  const explicitProduction =
    !["", "development"].includes(environment) && !isPreview;
  if (explicitProduction && dataSource !== "supabase") {
    throw new Error("正式站点必须使用 NEXT_PUBLIC_DATA_SOURCE=supabase");
  }
  const targetsProduction =
    explicitProduction ||
    (dataSource === "supabase" &&
      !isPreview &&
      (phase === PHASE_PRODUCTION_BUILD ||
        process.env.NODE_ENV === "production"));
  const siteKey = (process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "").trim();
  if (
    targetsProduction &&
    (!siteKey || /^[123]x0{20}[A-Z]{2}$/.test(siteKey))
  ) {
    throw new Error(
      "生产环境必须配置正式 Turnstile site key（禁止空值和测试 key）",
    );
  }
  return nextConfig;
}

