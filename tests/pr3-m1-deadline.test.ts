import { afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import * as middleware from "../lib/supabase/middleware";
import { proxy } from "../proxy";

// Deliberately use the real @supabase/ssr client and auth-js retry machinery.
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function jwt(exp: number) {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: "test-user", exp })}.${Buffer.from("test-signature").toString("base64url")}`;
}
it.each(["hung", "retry-hung", "retry-refreshed"])(
  "real auth-js stays within five seconds: %s",
  async (mode) => {
    const refreshSucceeds = mode === "retry-refreshed";
    vi.useFakeTimers();
    vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", "supabase");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://placeholder.invalid");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "placeholder-anon-key");
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException("Timeout", "TimeoutError")),
        ms,
      );
      return controller.signal;
    });
    const bridgeFactory = middleware.createClient;
    const respond = vi.fn();
    vi.spyOn(middleware, "createClient").mockImplementation((request) => {
      const bridge = bridgeFactory(request);
      return {
        ...bridge,
        respond: (response) => {
          respond(response);
          return bridge.respond(response);
        },
      };
    });
    let attempts = 0;
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) => {
        const signal = init!.signal!;
        signals.push(signal);
        if (String(_url).includes("/token?")) {
          attempts++;
          // Real auth-js must back off and retry these 503s before a hung fetch.
          if (mode !== "hung" && attempts <= 2)
            return Promise.resolve(Response.json({}, { status: 503 }));
          if (refreshSucceeds)
            return Promise.resolve(
              Response.json({
                access_token: jwt(Math.floor(Date.now() / 1000) + 3600),
                refresh_token: "test-refresh-new",
                token_type: "bearer",
                expires_in: 3600,
                user: { id: "test-user" },
              }),
            );
        }
        return new Promise<Response>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const session = {
      access_token: jwt(1),
      refresh_token: "test-refresh",
      expires_at: 1,
      user: { id: "test-user" },
    };
    const request = new NextRequest("https://site.example.invalid/store", {
      headers: {
        cookie: `sb-placeholder-auth-token=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`,
      },
    });
    const started = Date.now();
    let settled = false;
    const pending = proxy(request).then((response) => {
      settled = true;
      return response;
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(attempts).toBe(mode === "hung" ? 1 : 3);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;
    expect(Date.now() - started).toBeLessThanOrEqual(6000);
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("x-middleware-next")).toBeNull();
    expect(respond).toHaveBeenCalledExactlyOnceWith(response);
    if (refreshSucceeds)
      expect(
        response.cookies
          .getAll()
          .some((cookie) =>
            cookie.name.startsWith("sb-placeholder-auth-token"),
          ),
      ).toBe(true);
    expect(AbortSignal.timeout).toHaveBeenCalledExactlyOnceWith(5000);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    const networkCalls = fetchMock.mock.calls.length;
    // Let auth-js finish its retry/backoff loop. Expired retries cannot start network IO.
    await vi.advanceTimersByTimeAsync(35000);
    expect(fetchMock).toHaveBeenCalledTimes(networkCalls);
  },
);
