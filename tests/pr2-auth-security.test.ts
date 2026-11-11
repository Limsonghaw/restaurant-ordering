import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { safeNext } from "../lib/auth/safe-next";
import { hasFreshVerification } from "../lib/auth/reauth";
import { toAppCode, toAuthError } from "../lib/auth/gotrue-errors";
import { normalizePhone } from "../lib/validation/phone";
import { AppError, toErrorResponse } from "../lib/api/errors";
import { readFileSync } from "node:fs";
const fake = vi.hoisted(() => ({
  auth: { getClaims: vi.fn(), updateUser: vi.fn(), signOut: vi.fn() },
}));
vi.mock("../lib/supabase/server", () => ({ createClient: vi.fn(() => fake) }));
import { POST } from "../app/api/auth/set-password/route";
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://site.example.invalid");
  vi.stubEnv("NEXT_PUBLIC_AUTH_SMS_ALLOWED_COUNTRIES", "MY");
  vi.clearAllMocks();
  fake.auth.getClaims.mockResolvedValue({
    data: {
      claims: { amr: [{ method: "otp", timestamp: Date.now() / 1000 }] },
    },
    error: null,
  });
  fake.auth.updateUser.mockResolvedValue({ error: null });
  fake.auth.signOut.mockResolvedValue({ error: null });
});
afterEach(() => vi.unstubAllEnvs());
it.each([
  null,
  "",
  "https://evil.com",
  "//evil.com",
  "/\\evil.com",
  "/\t/evil.com",
  "/%09/evil.com",
  "/storeevil",
  "/admin",
  "/Store/menu",
  "/RESET-PASSWORD",
  "/reset-password/",
  "/set-password/",
  "/store/%252f%252fevil",
  "/store/%2f/evil",
  "/store/%5c/evil",
])("safeNext rejects %s", (value) => expect(safeNext(value)).toBe("/store"));
it.each([
  "/store/",
  "/store/menu",
  "/reset-password",
  "/set-password",
  "/store/menu?next=//evil.com",
])("safeNext permits %s", (value) => expect(safeNext(value)).toBe(value));
it("same origin absolute URL and fragment handling", () => {
  expect(safeNext("https://site.example.invalid/reset-password#token")).toBe(
    "/reset-password",
  );
  expect(safeNext("https://site.example.invalid.evil.com/store")).toBe(
    "/store",
  );
});
it.each(
  Object.entries({
    invalid_credentials: "INVALID_CREDENTIALS",
    user_not_found: "INVALID_CREDENTIALS",
    email_not_confirmed: "EMAIL_NOT_CONFIRMED",
    phone_not_confirmed: "PHONE_NOT_CONFIRMED",
    captcha_failed: "CAPTCHA_FAILED",
    otp_expired: "OTP_INVALID",
    otp_disabled: "OTP_INVALID",
    weak_password: "WEAK_PASSWORD",
    same_password: "VALIDATION_FAILED",
    over_request_rate_limit: "RATE_LIMITED",
    over_sms_send_rate_limit: "RATE_LIMITED",
    over_email_send_rate_limit: "RATE_LIMITED",
    sms_send_failed: "SMS_SEND_FAILED",
    validation_failed: "VALIDATION_FAILED",
    reauthentication_needed: "REAUTH_REQUIRED",
    session_not_found: "UNAUTHENTICATED",
    session_expired: "UNAUTHENTICATED",
    user_already_exists: "VALIDATION_FAILED",
    email_exists: "VALIDATION_FAILED",
    phone_exists: "VALIDATION_FAILED",
  }),
)("maps %s", (code, expected) => {
  expect(toAppCode({ code, message: "private provider text" })).toBe(expected);
  expect(
    toAuthError({ code, message: "private provider text" }).message,
  ).not.toContain("private");
});
it("unknown, hook, 429 and Twilio errors", () => {
  expect(toAppCode({ code: "unknown" })).toBe("INTERNAL");
  expect(toAppCode({ message: "PHONE_NOT_SUPPORTED" })).toBe(
    "PHONE_NOT_SUPPORTED",
  );
  expect(toAppCode({ status: 429 })).toBe("RATE_LIMITED");
  for (const message of [
    "60203",
    "Max send attempts reached",
    "too many requests",
    "429",
  ])
    expect(toAppCode({ code: "sms_send_failed", message })).toBe(
      "RATE_LIMITED",
    );
  expect(toAppCode({ code: "sms_send_failed" })).toBe("SMS_SEND_FAILED");
});
it("phone normalization and country/type/validity", () => {
  expect(normalizePhone("012-345 6789")).toBe("+60123456789");
  for (const value of ["+6581234567", "123", "+60312345678"])
    expect(() => normalizePhone(value)).toThrow();
});
it.each(["otp", "magiclink", "recovery", "email/signup", "sms/signup"])(
  "fresh amr %s",
  (method) => {
    const now = 1000000;
    expect(hasFreshVerification([{ method, timestamp: 700 }], now)).toBe(true);
    expect(hasFreshVerification([{ method, timestamp: 699 }], now)).toBe(false);
    expect(hasFreshVerification([{ method, timestamp: 1001 }], now)).toBe(
      false,
    );
  },
);
it("password login and malformed amr rejected", () => {
  for (const amr of [
    null,
    {},
    [{ method: "password", timestamp: Date.now() / 1000 }],
    [{ method: "otp", timestamp: "123" }],
  ])
    expect(hasFreshVerification(amr)).toBe(false);
});
function request(
  headers: Record<string, string> = {},
  body = JSON.stringify({ password: "password123" }),
) {
  return new Request("https://site.example.invalid/api/auth/set-password", {
    method: "POST",
    headers: {
      origin: "https://site.example.invalid",
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
}
it.each([
  "",
  "https://evil.com",
  "https://site.example.invalid.evil.com",
  "https://site.example.invalid/",
])("A6 rejects origin %s", async (origin) => {
  const res = await POST(request({ origin }));
  expect(res.status).toBe(403);
  expect(fake.auth.updateUser).not.toHaveBeenCalled();
});
it("A6 missing Origin and cross-site form", async () => {
  const req = request();
  req.headers.delete("origin");
  expect((await POST(req)).status).toBe(403);
  expect(
    (
      await POST(
        request(
          {
            "sec-fetch-site": "cross-site",
            "content-type": "application/x-www-form-urlencoded",
          },
          "password=x",
        ),
      )
    ).status,
  ).toBe(403);
});
it.each([
  "text/plain",
  "application/x-www-form-urlencoded",
  "application/jsonp",
])("A6 rejects content type %s", async (type) =>
  expect((await POST(request({ "content-type": type }))).status).toBe(415),
);
it("A6 fresh succeeds and revokes other sessions", async () => {
  const res = await POST(
    request({
      "sec-fetch-site": "same-origin",
      "content-type": "application/json; charset=utf-8",
    }),
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(fake.auth.updateUser).toHaveBeenCalledWith({
    password: "password123",
  });
  expect(fake.auth.signOut).toHaveBeenCalledWith({ scope: "others" });
});
it.each(["password", "expired"])("A6 reauth %s", async (method) => {
  fake.auth.getClaims.mockResolvedValue({
    data: {
      claims: {
        amr: [
          {
            method: method === "expired" ? "otp" : method,
            timestamp: (Date.now() - 300001) / 1000,
          },
        ],
      },
    },
  });
  const res = await POST(request());
  expect(res.status).toBe(401);
  expect((await res.json()).error.code).toBe("REAUTH_REQUIRED");
  expect(fake.auth.updateUser).not.toHaveBeenCalled();
});
it.each(["12345678", "abcdefghi", "abc1234"])(
  "A6 weak password %s",
  async (password) =>
    expect((await POST(request({}, JSON.stringify({ password })))).status).toBe(
      400,
    ),
);
it("A6 invalid JSON, no session, update error and logout error", async () => {
  expect((await POST(request({}, "{"))).status).toBe(400);
  fake.auth.getClaims.mockResolvedValue({ data: null });
  expect((await POST(request())).status).toBe(401);
  fake.auth.getClaims.mockRejectedValue(new Error("private"));
  const response = await POST(request());
  expect(response.status).toBe(500);
  expect(await response.text()).not.toContain("private");
});
it("fixed errors and status", async () => {
  for (const [code, status] of [
    ["MFA_REQUIRED", 403],
    ["UNSUPPORTED_MEDIA_TYPE", 415],
    ["REAUTH_REQUIRED", 401],
  ] as const) {
    const res = toErrorResponse(new AppError(code));
    expect(res.status).toBe(status);
    expect((await res.json()).error.code).toBe(code);
  }
});
it("Auth rate limits and disabled local provider use env references", () => {
  const config = readFileSync("supabase/config.toml", "utf8");
  for (const text of [
    "sms_sent = 20",
    "email_sent = 30",
    "sign_in_sign_ups = 15",
    "token_verifications = 15",
    'max_frequency = "60s"',
    "double_confirm_changes = true",
    "[auth.sms.twilio_verify]\nenabled = false",
    "env(TWILIO_ACCOUNT_SID)",
    "env(TWILIO_VERIFY_SERVICE_SID)",
    "env(TWILIO_AUTH_TOKEN)",
  ])
    expect(config).toContain(text);
});
it("A6 propagates mapped update and revocation failures", async () => {
  fake.auth.updateUser.mockResolvedValue({
    error: { code: "weak_password", message: "private" },
  });
  let res = await POST(request());
  expect(res.status).toBe(400);
  expect((await res.json()).error.code).toBe("WEAK_PASSWORD");
  expect(fake.auth.signOut).not.toHaveBeenCalled();
  fake.auth.updateUser.mockResolvedValue({ error: null });
  fake.auth.signOut.mockResolvedValue({
    error: { code: "unknown", message: "private" },
  });
  res = await POST(request());
  expect(res.status).toBe(500);
  expect((await res.json()).error.code).toBe("INTERNAL");
});

it("prototype names are unknown GoTrue codes", () => {
  for (const code of ["toString", "constructor", "__proto__"])
    expect(toAppCode({ code })).toBe("INTERNAL");
});
