import { afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const fake = vi.hoisted(() => ({
  options: null as unknown as { global: { fetch: typeof fetch } },
  fetchAuth: false,
}));
vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn((_url, _key, options) => {
    fake.options = options;
    options.cookies.setAll([
      { name: "refreshed", value: "test-only", options: { httpOnly: true } },
    ]);
    return {
      auth: {
        getClaims: async () => {
          if (fake.fetchAuth)
            await options.global.fetch("https://placeholder.invalid");
          return { data: null, error: null };
        },
      },
    };
  }),
}));
import { proxy } from "../proxy";
import { createClient } from "../lib/supabase/middleware";
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fake.fetchAuth = false;
});
function setup() {
  vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", "supabase");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://placeholder.invalid");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "placeholder-anon-key");
}
it("hung Supabase fetch aborts after five seconds; proxy returns 503 and refreshed cookies", async () => {
  setup();
  vi.useFakeTimers();
  // Node AbortSignal.timeout uses native timers: substitute a timer-backed equivalent for deterministic time travel.
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const c = new AbortController();
    setTimeout(() => c.abort(new DOMException("Timeout", "TimeoutError")), ms);
    return c.signal;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init.signal.addEventListener("abort", () =>
            reject(init.signal.reason),
          ),
        ),
    ),
  );
  fake.fetchAuth = true;
  let settled = false;
  const pending = proxy(
    new NextRequest("https://site.example.invalid/store"),
  ).then((r) => {
    settled = true;
    return r;
  });
  await vi.advanceTimersByTimeAsync(4999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  const response = await pending;
  expect(response.status).toBe(503);
  expect(response.cookies.get("refreshed")?.value).toBe("test-only");
  expect(response.headers.get("x-middleware-next")).toBeNull();
});
it("normal Supabase fetch preserves options and caller cancellation", async () => {
  setup();
  const fetch = vi.fn().mockResolvedValue(Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetch);
  createClient(new NextRequest("https://site.example.invalid/store"));
  const controller = new AbortController();
  const response = await fake.options.global.fetch(
    "https://placeholder.invalid",
    { method: "POST", signal: controller.signal },
  );
  expect(response.status).toBe(200);
  expect(fetch.mock.calls[0][1].method).toBe("POST");
  controller.abort();
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
});
