import { afterEach, expect, it, vi } from "vitest";
import { trustedIp } from "../lib/client-context";
afterEach(() => vi.unstubAllEnvs());
it("uses Cloudflare client IP instead of a forged forwarding header", () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("DEPLOYMENT_PLATFORM", "cloudflare");
  const request = new Request("https://example.invalid/api/t/code/menu", {
    headers: { "cf-connecting-ip": "192.0.2.5", "x-forwarded-for": "203.0.113.9" },
  });
  expect(trustedIp(request)).toBe("192.0.2.5");
});
it("does not trust Cloudflare headers on other platforms", () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("DEPLOYMENT_PLATFORM", "");
  expect(trustedIp(new Request("https://example.invalid", {
    headers: { "cf-connecting-ip": "192.0.2.5" },
  }))).toBe("unknown");
});
it("rejects malformed Cloudflare IP values", () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("DEPLOYMENT_PLATFORM", "cloudflare");
  expect(trustedIp(new Request("https://example.invalid", {
    headers: { "cf-connecting-ip": "not-an-ip" },
  }))).toBe("unknown");
});
