import { beforeEach, afterEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  auth: {
    signInWithOtp: vi.fn(),
    signInWithPassword: vi.fn(),
    verifyOtp: vi.fn(),
    signOut: vi.fn(),
    getClaims: vi.fn(),
    onAuthStateChange: vi.fn(),
  },
  rpc: vi.fn(),
}));
vi.mock("../lib/supabase/client", () => ({ createClient: () => fake }));
import * as auth from "../lib/data/supabase/auth-c";
import { getSession, onSessionChange } from "../lib/data/supabase/session";
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://site.example.invalid");
  for (const fn of [
    fake.auth.signInWithOtp,
    fake.auth.signInWithPassword,
    fake.auth.verifyOtp,
    fake.auth.signOut,
  ])
    fn.mockResolvedValue({ error: null });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it.each(["user_already_exists", "email_exists", "phone_exists", null])(
  "A1/A4/A8 symmetric existing account %s",
  async (code) => {
    fake.auth.signInWithOtp.mockResolvedValue({
      error: code ? { code, message: "private" } : null,
    });
    for (const send of [auth.sendSignUpOtp, auth.requestPasswordReset]) {
      await expect(
        send(
          { email: "Owner@example.invalid" },
          { captcha_token: "test-token" },
        ),
      ).resolves.toBeUndefined();
      expect(fake.auth.signInWithOtp).toHaveBeenLastCalledWith({
        email: "owner@example.invalid",
        options: {
          shouldCreateUser: true,
          captchaToken: "test-token",
          emailRedirectTo:
            "https://site.example.invalid" +
            (send === auth.sendSignUpOtp ? "/store" : "/reset-password"),
        },
      });
    }
  },
);
it("A1 sms, A2 captcha and unified credentials errors", async () => {
  await auth.sendSignUpOtp(
    { phone: "012-345 6789" },
    { captcha_token: "test-token" },
  );
  expect(fake.auth.signInWithOtp.mock.calls[0][0].phone).toBe("+60123456789");
  fake.auth.signInWithPassword.mockResolvedValue({
    error: { code: "invalid_credentials", message: "private" },
  });
  await expect(
    auth.signInWithPassword({
      email: "owner@example.invalid",
      password: "password123",
      captcha_token: "test-token",
    }),
  ).rejects.toMatchObject({
    code: "INVALID_CREDENTIALS",
    message: "账号或密码不正确",
  });
  expect(fake.auth.signInWithPassword.mock.calls[0][0].options).toEqual({
    captchaToken: "test-token",
  });
});
it.each(["email", "recovery", "email_change"])("A5 %s", async (type) => {
  expect(
    await auth.confirmEmailLink({
      token_hash: "test-hash",
      type,
      next: "/store/menu",
    }),
  ).toEqual({ next: "/store/menu" });
  expect(fake.auth.verifyOtp).toHaveBeenCalledWith({
    token_hash: "test-hash",
    type,
  });
});
it("A5 rejects disallowed types before auth; A7 errors unified", async () => {
  await expect(
    auth.confirmEmailLink({ token_hash: "test", type: "signup", next: null }),
  ).rejects.toMatchObject({ code: "RESET_LINK_INVALID" });
  expect(fake.auth.verifyOtp).not.toHaveBeenCalled();
  fake.auth.verifyOtp.mockResolvedValue({
    error: { code: "over_request_rate_limit" },
  });
  await expect(
    auth.verifySmsOtp({ phone: "012-345 6789", token: "123456" }),
  ).rejects.toMatchObject({ code: "OTP_INVALID" });
  expect(fake.auth.verifyOtp).toHaveBeenCalledWith({
    phone: "+60123456789",
    token: "123456",
    type: "sms",
  });
});
it("A3 and R14", async () => {
  await auth.signOut();
  expect(fake.auth.signOut).toHaveBeenCalled();
  fake.rpc.mockResolvedValue({
    data: { store_id: "test-store", created: true },
    error: null,
  });
  expect(await auth.ensureMyStore()).toEqual({
    store_id: "test-store",
    created: true,
  });
  expect(fake.rpc).toHaveBeenCalledWith("ensure_my_store");
});
it("A6 uses same-origin JSON fetch and whitelisted errors", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetcher);
  expect(await auth.setPassword("password123")).toEqual({
    ok: true,
    next: "/store",
  });
  expect(fetcher).toHaveBeenCalledWith(
    "/api/auth/set-password",
    expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "password123" }),
    }),
  );
  fetcher.mockResolvedValue(
    Response.json(
      { error: { code: "REAUTH_REQUIRED", message: "private" } },
      { status: 401 },
    ),
  );
  await expect(auth.setPassword("password123")).rejects.toMatchObject({
    code: "REAUTH_REQUIRED",
    message: "为了安全，请重新验证",
  });
});
it("M1 RPC context plus verified identity", async () => {
  fake.rpc.mockResolvedValue({
    data: { user_id: "test-user", store: null },
    error: null,
  });
  fake.auth.getClaims.mockResolvedValue({
    data: { claims: { email: "owner@example.invalid" } },
    error: null,
  });
  expect(await getSession()).toEqual({
    user_id: "test-user",
    store: null,
    user: { id: "test-user", email: "owner@example.invalid", phone: null },
  });
  expect(fake.rpc).toHaveBeenCalledWith("get_my_context");
  fake.rpc.mockResolvedValue({ data: null, error: null });
  expect(await getSession()).toBeNull();
  fake.rpc.mockResolvedValue({
    error: { code: "unknown", message: "private" },
  });
  await expect(getSession()).rejects.toMatchObject({ code: "INTERNAL" });
});
it("subscription deferred refresh and unsubscribe", async () => {
  vi.useFakeTimers();
  const unsubscribe = vi.fn();
  let listener: () => void = () => {};
  fake.auth.onAuthStateChange.mockImplementation((cb) => {
    listener = cb;
    return { data: { subscription: { unsubscribe } } };
  });
  fake.rpc.mockResolvedValue({ data: null, error: null });
  const cb = vi.fn();
  const stop = onSessionChange(cb);
  listener();
  expect(fake.rpc).not.toHaveBeenCalled();
  await vi.runAllTimersAsync();
  expect(cb).toHaveBeenCalledWith(null);
  stop();
  expect(unsubscribe).toHaveBeenCalled();
});
it("mock-only APIs stay unavailable", async () => {
  await expect(auth.getAuthMockSnapshot()).rejects.toMatchObject({
    code: "NOT_IMPLEMENTED",
  });
  await expect(auth.authMockAction("identity")).rejects.toMatchObject({
    code: "NOT_IMPLEMENTED",
  });
});

it("M1 anonymous skips RPC", async () => {
  fake.auth.getClaims.mockResolvedValue({ data: null, error: null });
  expect(await getSession()).toBeNull();
  expect(fake.rpc).not.toHaveBeenCalled();
  fake.auth.getClaims.mockResolvedValue({
    error: { name: "AuthSessionMissingError" },
  });
  expect(await getSession()).toBeNull();
});
