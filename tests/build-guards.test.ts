import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD } from "next/constants";
import config from "../next.config";

beforeEach(() => {
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", "supabase");
  vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "placeholder-site-key");
});
afterEach(() => vi.unstubAllEnvs());

describe("M-1 数据源必须显式选择", () => {
  it.each([undefined, "", "SUPABASE", "typo"])("拒绝数据源 %s", (source) => {
    vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", source);
    expect(() => config(PHASE_PRODUCTION_BUILD)).toThrow("NEXT_PUBLIC_DATA_SOURCE");
  });
  it("正式站点拒绝 mock，但预览可显式使用 mock", () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", "mock");
    expect(config(PHASE_PRODUCTION_BUILD)).toBeDefined();
    vi.stubEnv("VERCEL_ENV", "production");
    expect(() => config(PHASE_PRODUCTION_BUILD)).toThrow("正式站点");
  });
  it("未配置数据源时数据层不会选择 mock", async () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", undefined);
    vi.resetModules();
    const data = await import("../lib/data");
    expect(data.isMock).toBe(false);
    await expect(data.getTableMenu("demo-a1")).rejects.toMatchObject({
      code: "NOT_IMPLEMENTED",
    });
  });
});

describe("L-1 非 Vercel 生产构建 Turnstile 护栏", () => {
  it.each([
    undefined, "", "   ",
    "1x00000000000000000000AA",
    "2x00000000000000000000AB",
    "3x00000000000000000000FF",
    "1x00000000000000000000BB",
    "2x00000000000000000000BB",
    " 1x00000000000000000000BB ",
  ])("拒绝空或测试 key %s", (key) => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", key);
    expect(() => config(PHASE_PRODUCTION_BUILD)).toThrow("Turnstile");
  });
  it("也覆盖 Vercel production 和 NODE_ENV production", () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(() => config(PHASE_DEVELOPMENT_SERVER)).toThrow("Turnstile");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(() => config(PHASE_DEVELOPMENT_SERVER)).toThrow("Turnstile");
  });
  it("允许非测试占位 key", () => {
    expect(config(PHASE_PRODUCTION_BUILD)).toBeDefined();
  });
});
