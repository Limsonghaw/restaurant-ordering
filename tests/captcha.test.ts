import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { Captcha } from "../lib/ui/captcha";

afterEach(() => vi.unstubAllEnvs());

it("L-1 缺少 key 的 supabase 模式不提供假令牌复选框", () => {
  vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "   ");
  vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", "supabase");
  const render = () => renderToStaticMarkup(createElement(Captcha, {
    onToken: vi.fn(), onExpire: vi.fn(), resetKey: 0,
  }));
  expect(render()).toContain("验证组件未配置");
  expect(render()).not.toContain('type="checkbox"');
  vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", "mock");
  expect(render()).toContain('type="checkbox"');
});
