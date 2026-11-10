import type { NextConfig } from "next";

const testKeys = [
  "1x00000000000000000000AA",
  "2x00000000000000000000AB",
  "3x00000000000000000000FF",
];
if (
  process.env.VERCEL_ENV === "production" &&
  testKeys.includes(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "")
) {
  throw new Error("生产环境禁止使用 Turnstile 测试 site key");
}
const nextConfig: NextConfig = {};
export default nextConfig;
