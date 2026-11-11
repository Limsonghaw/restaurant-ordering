import { afterEach, beforeEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  query: vi.fn(),
  begin: vi.fn(),
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
  customerDatabaseSsl,
  customerGetMenu,
  customerQuote,
  customerPlaceOrder,
  customerCheckReplay,
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
  fake.factory.mockReturnValue(
    Object.assign(fake.query, { json: fake.json, begin: fake.begin }),
  );
  fake.query.mockResolvedValue([{ result: { ok: true } }]);
  fake.begin.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(fake.query),
  );
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
it("only four parameterized RPCs and fixed pool options without Supavisor startup options", async () => {
  expect(await customerGetMenu(table)).toEqual({ ok: true });
  expect(fake.factory).toHaveBeenCalledWith(
    expect.stringContaining("database.invalid"),
    {
      max: 1,
      prepare: false,
      ssl: "require",
      idle_timeout: 20,
      connect_timeout: 5,
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

const replayArgs = {
  ...table,
  items: [],
  request_id: table.table_id,
  request_hash: "a".repeat(64),
  device_hash: "b".repeat(64),
  ip_hash: "c".repeat(64),
  bill_token_hash: null,
  new_bill_token_hash: "d".repeat(64),
  captcha_verified: true,
};
it.each(["replay", "missing", "mismatch"])(
  "read-only replay check returns %s without transactions",
  async (status) => {
    const result =
      status === "mismatch"
        ? { status, code: "IDEMPOTENCY_KEY_REUSED" }
        : { status };
    fake.query.mockResolvedValue([{ result }]);
    expect(await customerCheckReplay(replayArgs)).toEqual(result);
    expect(fake.begin).not.toHaveBeenCalled();
    expect(fake.query.mock.calls[0][0].join("?")).toContain(
      "public.customer_check_replay",
    );
    expect(fake.query.mock.calls[0][0].join("?")).not.toContain(
      "customer_place_order",
    );
  },
);
it.each(["CAPTCHA_REQUIRED", "RATE_LIMITED", "IDEMPOTENCY_KEY_REUSED"])(
  "read-only check business failure %s is propagated",
  async (message) => {
    fake.query.mockRejectedValue({ code: "P0001", message });
    await expect(customerCheckReplay(replayArgs)).rejects.toMatchObject({
      code: message,
    });
    expect(fake.begin).not.toHaveBeenCalled();
  },
);
it("probe infrastructure failures fail closed", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  fake.query.mockRejectedValue({ code: "57014" });
  await expect(customerCheckReplay(replayArgs)).rejects.toMatchObject({
    code: "INTERNAL",
  });
  log.mockRestore();
});
it("database retry seconds survive allowlisting but arbitrary details do not", () => {
  const error = mapCustomerError({
    code: "P0001",
    message: "RATE_LIMITED",
    detail: JSON.stringify({
      scope: "table_db",
      retry_after_seconds: 120.1,
      secret: "private",
    }),
  });
  expect(error.details).toEqual({
    scope: "table_db",
    retry_after_seconds: 121,
  });
});

it.each(["localhost", "127.0.0.1", "[::1]", "database.invalid"])(
  "SSL disable is restricted to local nonproduction: %s",
  (host) => {
    const url = `postgres://placeholder:placeholder@${host}:5432/placeholder`;
    expect(customerDatabaseSsl(url)).toBe("require");
    vi.stubEnv("CUSTOMER_DB_SSL", "disable");
    expect(customerDatabaseSsl(url)).toBe(
      host === "database.invalid" ? "require" : false,
    );
    vi.stubEnv("NODE_ENV", "production");
    expect(customerDatabaseSsl(url)).toBe("require");
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(customerDatabaseSsl(url)).toBe("require");
  },
);
