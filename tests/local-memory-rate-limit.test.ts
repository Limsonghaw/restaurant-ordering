import { afterEach, expect, it, vi } from "vitest";
import { isNonLocalEnv, isLocalMemoryRateLimitEnabled } from "../lib/env";
import { register } from "../instrumentation";
import {
  limit,
  memoryRateLimitActive,
  getRateLimiter,
  rateLimiter,
  MemoryRateLimiter,
} from "../lib/ratelimit";

afterEach(() => {
  vi.unstubAllEnvs();
});

function localNoUpstash() {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("VERCEL_ENV", "");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
}

it.each([
  ["NODE_ENV", "production"],
  ["VERCEL_ENV", "preview"],
  ["VERCEL_ENV", "production"],
])("refuses the memory limiter switch in %s=%s", async (name, value) => {
  vi.stubEnv("NODE_ENV", name === "NODE_ENV" ? value : "development");
  vi.stubEnv("VERCEL_ENV", name === "VERCEL_ENV" ? value : "");
  vi.stubEnv("LOCAL_MEMORY_RATE_LIMIT", "1");
  expect(isNonLocalEnv()).toBe(true);
  expect(isLocalMemoryRateLimitEnabled()).toBe(true);
  expect(register).toThrow("LOCAL_MEMORY_RATE_LIMIT");
  expect(memoryRateLimitActive()).toBe(false);
  expect(getRateLimiter()).toBe(rateLimiter);
  expect(getRateLimiter()).not.toBeInstanceOf(MemoryRateLimiter);
  await expect(limit("menuIp", crypto.randomUUID())).rejects.toMatchObject({
    code: "RATE_LIMITED",
  });
});

it("switch must be 1; default and other values stay off", () => {
  localNoUpstash();
  expect(memoryRateLimitActive()).toBe(false);
  vi.stubEnv("LOCAL_MEMORY_RATE_LIMIT", "0");
  expect(memoryRateLimitActive()).toBe(false);
  vi.stubEnv("LOCAL_MEMORY_RATE_LIMIT", "true");
  expect(memoryRateLimitActive()).toBe(false);
  vi.stubEnv("LOCAL_MEMORY_RATE_LIMIT", "1");
  expect(memoryRateLimitActive()).toBe(true);
  expect(getRateLimiter()).toBeInstanceOf(MemoryRateLimiter);
  expect(register()).toBeUndefined();
});

it("when enabled, menu/quote/bill/order use the same limits and still allow under the cap", async () => {
  localNoUpstash();
  vi.stubEnv("LOCAL_MEMORY_RATE_LIMIT", "1");
  const menu = crypto.randomUUID();
  for (let i = 0; i < 60; i++) expect(await limit("menuIp", menu)).toBe(false);
  await expect(limit("menuIp", menu)).rejects.toMatchObject({
    code: "RATE_LIMITED",
  });
  const quote = crypto.randomUUID();
  for (let i = 0; i < 30; i++)
    expect(await limit("quoteDevice", quote)).toBe(false);
  await expect(limit("quoteDevice", quote)).rejects.toMatchObject({
    code: "RATE_LIMITED",
  });
  const bill = crypto.randomUUID();
  for (let i = 0; i < 120; i++) expect(await limit("billIp", bill)).toBe(false);
  await expect(limit("billIp", bill)).rejects.toMatchObject({
    code: "RATE_LIMITED",
  });
  const probe = crypto.randomUUID();
  for (let i = 0; i < 30; i++)
    expect(await limit("orderProbeDevice", probe)).toBe(false);
  await expect(limit("orderProbeDevice", probe)).rejects.toMatchObject({
    code: "RATE_LIMITED",
  });
});

it("when disabled, missing Upstash stays fail-closed", async () => {
  localNoUpstash();
  expect(memoryRateLimitActive()).toBe(false);
  await expect(limit("menuIp", crypto.randomUUID())).rejects.toMatchObject({
    code: "RATE_LIMITED",
  });
  await expect(limit("quoteDevice", crypto.randomUUID())).rejects.toMatchObject(
    { code: "RATE_LIMITED" },
  );
  await expect(limit("billIp", crypto.randomUUID())).rejects.toMatchObject({
    code: "RATE_LIMITED",
  });
  expect(await limit("orderProbeDevice", crypto.randomUUID())).toBe(true);
  expect(await limit("orderDeviceMinute", crypto.randomUUID())).toBe(true);
});

it("does not use memory when Upstash is configured, even if the switch is on", () => {
  localNoUpstash();
  vi.stubEnv("LOCAL_MEMORY_RATE_LIMIT", "1");
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://example.invalid");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "placeholder-token");
  expect(memoryRateLimitActive()).toBe(false);
  expect(getRateLimiter()).toBe(rateLimiter);
});
