import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  query: vi.fn(),
  json: vi.fn((v: unknown) => v),
  factory: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  rows: [] as { id: string; label: string; qr_version: number }[],
}));
vi.mock("postgres", () => ({ default: fake.factory }));
vi.mock("../lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ rpc: fake.rpc, from: fake.from })),
}));
import {
  customerGetMenu,
  customerQuote,
  customerPlaceOrder,
  customerGetBill,
  mapCustomerError,
} from "../lib/supabase/customer";
import { getTableQrLinks } from "../app/store/tables/actions";
import { verifyTableCode } from "../lib/qr";
import { RedisRateLimiter } from "../lib/ratelimit";
const table = {
  store_id: "11111111-1111-4111-8111-111111111111",
  table_id: "22222222-2222-4222-8222-222222222222",
  qr_version: 1,
};
beforeEach(() => {
  vi.stubEnv(
    "CUSTOMER_API_DATABASE_URL",
    "postgres://placeholder:placeholder@database.invalid:6543/placeholder",
  );
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://site.example.invalid");
  vi.stubEnv("QR_SIGNING_SECRET", "unit-test");
  fake.factory.mockReturnValue(Object.assign(fake.query, { json: fake.json }));
  fake.query.mockResolvedValue([{ result: { ok: true } }]);
  fake.rpc.mockResolvedValue({
    data: { store: { id: table.store_id } },
    error: null,
  });
  fake.rows = [{ id: table.table_id, label: "A1", qr_version: 1 }];
  fake.from.mockImplementation(() => {
    const q = {
      select: vi.fn(() => q),
      eq: vi.fn(() => q),
      is: vi.fn(() => q),
      in: vi.fn(async () => ({ data: fake.rows, error: null })),
    };
    return q;
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("only four parameterized RPCs and fixed pool/session timeout options", async () => {
  expect(await customerGetMenu(table)).toEqual({ ok: true });
  expect(fake.factory).toHaveBeenCalledWith(
    expect.stringContaining("database.invalid"),
    {
      max: 1,
      prepare: false,
      ssl: "require",
      idle_timeout: 20,
      connect_timeout: 5,
      connection: { options: "-c statement_timeout=3000" },
    },
  );
  await customerQuote(table, []);
  await customerGetBill(table, null, null);
  await customerPlaceOrder({
    ...table,
    items: [],
    request_id: table.table_id,
    request_hash: "a".repeat(64),
    device_hash: "b".repeat(64),
    ip_hash: "c".repeat(64),
    bill_token_hash: null,
    new_bill_token_hash: "d".repeat(64),
    captcha_verified: true,
  });
  expect(
    fake.query.mock.calls.map(
      (c) => c[0].join("?").match(/public\.(\w+)/)?.[1],
    ),
  ).toEqual([
    "customer_get_menu",
    "customer_quote",
    "customer_get_bill",
    "customer_place_order",
  ]);
});
it("P0001 uses whitelist; details drop private fields, unknown codes fail closed", () => {
  const e = mapCustomerError({
    code: "P0001",
    message: "PRICE_CHANGED",
    detail: JSON.stringify({
      secret: "private",
      items: [
        {
          item_id: "id",
          name: "food",
          client_unit_price_cents: 1,
          current_unit_price_cents: 2,
          token: "private",
        },
      ],
    }),
  });
  expect(e).toMatchObject({
    code: "PRICE_CHANGED",
    details: {
      items: [
        {
          item_id: "id",
          name: "food",
          client_unit_price_cents: 1,
          current_unit_price_cents: 2,
        },
      ],
    },
  });
  expect(JSON.stringify(e)).not.toContain("private");
  for (const reason of ["bill_paid", "qr_rotated", "expired"])
    expect(
      mapCustomerError({
        code: "P0001",
        message: "BILL_TOKEN_EXPIRED",
        detail: JSON.stringify({ reason }),
      }),
    ).toMatchObject({ details: { reason } });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  for (const code of ["57014", "ECONNREFUSED", "P0001"])
    expect(mapCustomerError({ code, message: "private" })).toMatchObject({
      code: "INTERNAL",
    });
  expect(log).toHaveBeenCalledTimes(3);
  expect(JSON.stringify(log.mock.calls)).not.toContain("private");
  log.mockRestore();
});
it("RPC errors are mapped without leaking database messages", async () => {
  fake.query.mockRejectedValue({ code: "P0001", message: "STORE_CLOSED" });
  await expect(customerGetMenu(table)).rejects.toMatchObject({
    code: "STORE_CLOSED",
  });
});
it("S1 verifies ownership before signing and returns matching links", async () => {
  const links = await getTableQrLinks([table.table_id]);
  expect(links[0].label).toBe("A1");
  expect(verifyTableCode(links[0].url.split("/t/")[1])).toEqual(table);
  const q = fake.from.mock.results[0].value;
  expect(q.eq).toHaveBeenCalledWith("store_id", table.store_id);
  fake.rows = [];
  await expect(getTableQrLinks([table.table_id])).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  fake.rpc.mockResolvedValue({ data: null, error: null });
  await expect(getTableQrLinks([table.table_id])).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
  await expect(getTableQrLinks(["bad"])).rejects.toMatchObject({
    code: "VALIDATION_FAILED",
  });
});
it("Redis REST uses atomic sliding window and fails on missing config/errors", async () => {
  const redis = new RedisRateLimiter();
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(redis.hit("key", 60000)).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  vi.stubEnv("UPSTASH_REDIS_REST_URL", "https://redis.example.invalid");
  vi.stubEnv("UPSTASH_REDIS_REST_TOKEN", "test-only");
  fetch.mockResolvedValue(Response.json({ result: 3 }));
  expect(await redis.hit("key", 60000)).toBe(3);
  const command = JSON.parse(fetch.mock.calls[0][1].body);
  expect(command[0]).toBe("EVAL");
  expect(command[1]).toContain("ZREMRANGEBYSCORE");
  expect(command[3]).toBe("customer:key");
  fetch.mockResolvedValue(Response.json({ error: "offline" }));
  await expect(redis.hit("key", 60000)).rejects.toThrow();
});
