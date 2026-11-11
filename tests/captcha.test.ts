import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { Captcha } from "../lib/ui/captcha";

afterEach(() => vi.unstubAllEnvs());

it("L-1 缺少 key 的 supabase 模式不提供假令牌复选框", () => {
  vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "   ");
  vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", "supabase");
  const render = () =>
    renderToStaticMarkup(
      createElement(Captcha, {
        action: "login",
        onToken: vi.fn(),
        onExpire: vi.fn(),
        resetKey: 0,
      }),
    );
  expect(render()).toContain("验证组件未配置");
  expect(render()).not.toContain('type="checkbox"');
  vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", "mock");
  expect(render()).toContain('type="checkbox"');
});

const hookProbe = vi.hoisted(() => ({
  active: false,
  effects: [] as (() => unknown)[],
}));
vi.mock("react", async (original) => {
  const real = await original<typeof import("react")>();
  return {
    ...real,
    useRef: (value: unknown) =>
      hookProbe.active
        ? { current: value === null ? {} : value }
        : real.useRef(value),
    useState: (value: unknown) =>
      hookProbe.active ? [value, vi.fn()] : real.useState(value),
    useEffect: (effect: () => void | (() => void), deps: unknown[]) =>
      hookProbe.active
        ? hookProbe.effects.push(effect)
        : real.useEffect(effect, deps),
  };
});
it.each(["place_order", "signup", "login", "recover", "resend"] as const)(
  "Turnstile render 收到 action=%s",
  async (action) => {
    const render = vi.fn(() => "widget");
    vi.stubGlobal("window", { turnstile: { render, remove: vi.fn() } });
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "placeholder-site-key");
    hookProbe.active = true;
    hookProbe.effects = [];
    try {
      Captcha({ action, resetKey: 0, onToken: vi.fn(), onExpire: vi.fn() });
      hookProbe.effects.forEach((effect) => effect());
      await Promise.resolve();
      await Promise.resolve();
      expect(render).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action, sitekey: "placeholder-site-key" }),
      );
    } finally {
      hookProbe.active = false;
      vi.unstubAllGlobals();
    }
  },
);
