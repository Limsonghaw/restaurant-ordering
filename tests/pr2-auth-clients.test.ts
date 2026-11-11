import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const mocks = vi.hoisted(() => ({
  server: vi.fn(),
  browser: vi.fn(),
  set: vi.fn(),
}));
vi.mock("@supabase/ssr", () => ({
  createServerClient: mocks.server,
  createBrowserClient: mocks.browser,
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [{ name: "test", value: "local" }],
    set: mocks.set,
  }),
}));
import { createClient as server } from "../lib/supabase/server";
import { createClient as browser } from "../lib/supabase/client";
import { createClient as middleware } from "../lib/supabase/middleware";
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://placeholder.invalid");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "placeholder-anon");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "placeholder-publishable");
});
afterEach(() => vi.unstubAllEnvs());
it.each(["placeholder-publishable", ""])(
  "all clients prefer publishable with anon fallback %s",
  async (key) => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", key);
    await server();
    browser();
    middleware(new NextRequest("https://site.example.invalid"));
    expect(
      mocks.server.mock.calls.every(
        (call) => call[1] === (key || "placeholder-anon"),
      ),
    ).toBe(true);
    expect(mocks.server).toHaveBeenCalledTimes(2);
    expect(mocks.browser).toHaveBeenCalledWith(
      "https://placeholder.invalid",
      key || "placeholder-anon",
      expect.objectContaining({
        cookieOptions: expect.objectContaining({ sameSite: "lax" }),
      }),
    );
  },
);
it("server cookie bridge", async () => {
  await server();
  const adapter = mocks.server.mock.calls[0][2].cookies;
  expect(adapter.getAll()).toEqual([{ name: "test", value: "local" }]);
  adapter.setAll([{ name: "test", value: "new", options: { httpOnly: true } }]);
  expect(mocks.set).toHaveBeenCalledWith("test", "new", { httpOnly: true });
});
it("proxy bridge updates request and every response", () => {
  const request = new NextRequest("https://site.example.invalid");
  const bridge = middleware(request);
  const adapter = mocks.server.mock.calls[0][2].cookies;
  adapter.setAll([
    {
      name: "test",
      value: "new",
      options: { httpOnly: true, sameSite: "lax", secure: true },
    },
  ]);
  expect(adapter.getAll()).toContainEqual({ name: "test", value: "new" });
  const response = bridge.respond();
  expect(response.cookies.get("test")).toMatchObject({
    value: "new",
    httpOnly: true,
    sameSite: "lax",
    secure: true,
  });
});
it("missing config fails", async () => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
  await expect(server()).rejects.toThrow();
  expect(browser).toThrow();
  expect(() =>
    middleware(new NextRequest("https://site.example.invalid")),
  ).toThrow();
});

it("production cookie options are Secure and SameSite=Lax on every client", async () => {
  vi.stubEnv("NODE_ENV", "production");
  await server();
  browser();
  middleware(new NextRequest("https://site.example.invalid"));
  for (const call of [...mocks.server.mock.calls, ...mocks.browser.mock.calls])
    expect(call[2].cookieOptions).toEqual({ sameSite: "lax", secure: true });
});
