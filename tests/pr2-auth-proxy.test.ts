import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getAuthState,
  evaluateAccess,
  type AuthState,
} from "../lib/auth/guard";
const fake = vi.hoisted(() => ({
  auth: { getClaims: vi.fn() },
  rpc: vi.fn(),
  refresh: false,
}));
vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn((_url, _key, options) => {
    if (fake.refresh)
      options.cookies.setAll([
        {
          name: "refreshed",
          value: "test-only",
          options: { httpOnly: true, sameSite: "lax" },
        },
      ]);
    return fake;
  }),
}));
import { proxy } from "../proxy";
beforeEach(() => {
  vi.clearAllMocks();
  fake.refresh = true;
  vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", "supabase");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://placeholder.invalid");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "placeholder-anon-key");
  fake.auth.getClaims.mockResolvedValue({ data: null, error: null });
  fake.rpc.mockResolvedValue({ data: null, error: null });
});
afterEach(() => vi.unstubAllEnvs());
it("anonymous skips RPC and redirects preserving refresh cookies", async () => {
  const res = await proxy(
    new NextRequest("https://site.example.invalid/store/menu?x=1"),
  );
  expect(res.status).toBe(307);
  expect(res.headers.get("location")).toBe(
    "https://site.example.invalid/login?next=%2Fstore%2Fmenu%3Fx%3D1",
  );
  expect(res.cookies.get("refreshed")?.value).toBe("test-only");
  expect(fake.rpc).not.toHaveBeenCalled();
});
it("session missing is anonymous; other claims errors throw", async () => {
  fake.auth.getClaims.mockResolvedValue({
    error: { name: "AuthSessionMissingError" },
  });
  expect(await getAuthState(fake as unknown as SupabaseClient)).toEqual({
    kind: "anonymous",
  });
  fake.auth.getClaims.mockResolvedValue({ error: { name: "AuthApiError" } });
  await expect(getAuthState(fake as unknown as SupabaseClient)).rejects.toEqual(
    { name: "AuthApiError" },
  );
});
it("RPC failure is fail-closed with cookies", async () => {
  fake.auth.getClaims.mockResolvedValue({ data: { claims: { sub: "test" } } });
  fake.rpc.mockResolvedValue({ error: { message: "private database error" } });
  const res = await proxy(
    new NextRequest("https://site.example.invalid/store"),
  );
  expect(res.status).toBe(503);
  expect(res.headers.get("x-middleware-next")).toBeNull();
  expect(await res.text()).not.toContain("private");
  expect(res.cookies.get("refreshed")).toBeDefined();
});
it("mock bypasses all auth", async () => {
  vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", "mock");
  expect(
    (
      await proxy(new NextRequest("https://site.example.invalid/store"))
    ).headers.get("x-middleware-next"),
  ).toBe("1");
  expect(fake.auth.getClaims).not.toHaveBeenCalled();
});
const contexts = [
  null,
  { platform_role: "platform_admin", aal: "aal1" },
  { platform_role: "platform_admin", aal: "aal2" },
  { platform_role: "merchant", store: null },
  {
    platform_role: "merchant",
    store: { id: "s", status: "active", is_profile_complete: false },
    password_set_at: null,
  },
  {
    platform_role: "merchant",
    store: { id: "s", status: "active", is_profile_complete: true },
    password_set_at: "now",
  },
];
const states: AuthState[] = [
  { kind: "anonymous" },
  { kind: "needs_mfa" },
  { kind: "platform_admin" },
  { kind: "no_store" },
  { kind: "needs_password" },
  {
    kind: "ready",
    storeId: "s",
    storeStatus: "active",
    isProfileComplete: true,
  },
];
it.each(states.map((state, i) => [state.kind, i] as const))(
  "proxy matches guard state %s across routes",
  async (_kind, i) => {
    fake.auth.getClaims.mockResolvedValue({
      data: { claims: { sub: "test" } },
    });
    fake.rpc.mockResolvedValue({ data: contexts[i], error: null });
    for (const path of [
      "/store/menu",
      "/admin/users",
      "/set-password",
      "/verify",
      "/login",
      "/reset-password",
      "/admin/mfa",
    ]) {
      const res = await proxy(
        new NextRequest("https://site.example.invalid" + path),
      );
      const decision = evaluateAccess(path, states[i]);
      expect(res.status).toBe(decision.allow ? 200 : 307);
      if (!decision.allow)
        expect(res.headers.get("location")).toBe(
          new URL(decision.to, "https://site.example.invalid").href,
        );
      expect(res.cookies.get("refreshed")).toBeDefined();
    }
  },
);
