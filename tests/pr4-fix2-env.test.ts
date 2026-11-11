import { afterEach, expect, it, vi } from "vitest";
import { isNonLocalEnv } from "../lib/env";
import { register } from "../instrumentation";
import { customerDatabaseSsl } from "../lib/supabase/customer";
import { trustedIp } from "../lib/client-context";
import { AppError, toErrorResponse } from "../lib/api/errors";
afterEach(() => vi.unstubAllEnvs());
it.each(["localhost", "localhost:5432", "user@localhost", "127.0.0.1"])(
  "local SSL opt-out: %s",
  (host) => {
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("CUSTOMER_DB_SSL", "disable");
    expect(customerDatabaseSsl(`postgres://${host}/placeholder`)).toBe(false);
    expect(register()).toBeUndefined();
  },
);
it.each([
  "localhost.evil.com",
  "127.0.0.1.nip.io",
  "evil-localhost",
  "[::1]",
  "LOCALHOST",
])("SSL stays required: %s", (host) => {
  vi.stubEnv("CUSTOMER_DB_SSL", "disable");
  expect(customerDatabaseSsl(`postgres://${host}/placeholder`)).toBe("require");
});
it.each([
  ["NODE_ENV", "production"],
  ["VERCEL_ENV", "preview"],
  ["VERCEL_ENV", "production"],
  ["VERCEL_ENV", " development "],
])("startup refuses local overrides in %s=%s", (name, value) => {
  vi.stubEnv(name, value);
  expect(isNonLocalEnv()).toBe(true);
  expect(register()).toBeUndefined();
  expect(customerDatabaseSsl("postgres://localhost/placeholder")).toBe(
    "require",
  );
  vi.stubEnv("TRUST_LOCAL_IP", "1");
  expect(register).toThrow("TRUST_LOCAL_IP");
  expect(
    trustedIp(
      new Request("https://example.invalid", {
        headers: { "x-real-ip": "192.0.2.1" },
      }),
    ),
  ).toBe("unknown");
  vi.stubEnv("TRUST_LOCAL_IP", undefined);
  vi.stubEnv("CUSTOMER_DB_SSL", "disable");
  expect(register).toThrow("CUSTOMER_DB_SSL");
  expect(customerDatabaseSsl("postgres://localhost/placeholder")).toBe(
    "require",
  );
  vi.stubEnv("CUSTOMER_DB_SSL", "require");
  vi.stubEnv("LOCAL_MEMORY_RATE_LIMIT", "1");
  expect(register).toThrow("LOCAL_MEMORY_RATE_LIMIT");
});
it("only VERCEL=1 trusts the platform header", () => {
  vi.stubEnv("VERCEL_ENV", "preview");
  const r = new Request("https://example.invalid", {
    headers: { "x-vercel-forwarded-for": "192.0.2.1" },
  });
  vi.stubEnv("VERCEL", "");
  expect(trustedIp(r)).toBe("unknown");
  vi.stubEnv("VERCEL", "1");
  expect(trustedIp(r)).toBe("192.0.2.1");
});
it.each([
  [1e12, "3600"],
  [0, "60"],
  [-1, "60"],
  [NaN, "60"],
  [0.2, "1"],
])("Retry-After bounds %s", (value, expected) => {
  expect(
    toErrorResponse(
      new AppError("RATE_LIMITED", { retry_after_seconds: value }),
    ).headers.get("retry-after"),
  ).toBe(expected);
});
