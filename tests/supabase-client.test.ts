import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient } from "../lib/supabase/client";

afterEach(() => vi.unstubAllEnvs());

describe("Supabase 浏览器客户端", () => {
  it("缺少公开配置时给出明确错误", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    expect(() => createClient()).toThrow("请配置 Supabase 公开环境变量");
  });
});
