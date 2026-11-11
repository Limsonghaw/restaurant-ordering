import { beforeEach, afterEach, expect, it, vi } from "vitest";
const rpc = vi.hoisted(() => ({
  customerGetMenu: vi.fn(),
  customerQuote: vi.fn(),
  customerPlaceOrder: vi.fn(),
  customerGetBill: vi.fn(),
}));
vi.mock("../lib/supabase/customer", () => rpc);
import { GET as menu } from "../app/api/t/[code]/menu/route";
import { POST as quote } from "../app/api/t/[code]/quote/route";
import { POST as order } from "../app/api/t/[code]/orders/route";
import { GET as bill } from "../app/api/t/[code]/bill/route";
import { signTableCode, verifyTableCode } from "../lib/qr";
import { clientHash, requestHash, sha256 } from "../lib/hash";
import {
  issueDevice,
  device,
  trustedIp,
  billCookieName,
} from "../lib/client-context";
import {
  MemoryRateLimiter,
  rateLimiter,
  limit,
  scopes,
} from "../lib/ratelimit";
import { verifyTurnstile } from "../lib/turnstile";
import { AppError } from "../lib/api/errors";
const store_id = "11111111-1111-4111-8111-111111111111",
  table_id = "22222222-2222-4222-8222-222222222222";
const table = { store_id, table_id, qr_version: 7 };
const items = [
  { item_id: table_id, quantity: 1, unit_price_cents: 1200, note: "" },
];
let code: string, did: string, memory: MemoryRateLimiter;
const context = () => ({ params: Promise.resolve({ code }) });
function req(body?: unknown, extra: Record<string, string> = {}) {
  return new Request("https://site.example.invalid/api/t/code", {
    method: body ? "POST" : "GET",
    headers: {
      cookie: `did=${did}`,
      "x-real-ip": "192.0.2.1",
      ...(body ? { "content-type": "application/json" } : {}),
      ...extra,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
const body = (captcha_token?: string) => ({
  items,
  client_request_id: table_id,
  ...(captcha_token ? { captcha_token } : {}),
});
const err = async (response: Response) => (await response.json()).error.code;
beforeEach(() => {
  vi.stubEnv("QR_SIGNING_SECRET", "unit-test-qr");
  vi.stubEnv("DEVICE_COOKIE_SECRET", "unit-test-device");
  vi.stubEnv("CLIENT_HASH_SECRET", "unit-test-hash");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://site.example.invalid");
  vi.stubEnv("TURNSTILE_SECRET_KEY", "1x0000000000000000000000000000000AA");
  code = signTableCode(table);
  did = issueDevice();
  memory = new MemoryRateLimiter();
  vi.spyOn(rateLimiter, "hit").mockImplementation((k, w) => memory.hit(k, w));
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        success: true,
        action: "place_order",
        hostname: "site.example.invalid",
      }),
    ),
  );
  rpc.customerGetMenu.mockResolvedValue({
    store: { is_accepting_orders: false },
    table_in_use: true,
  });
  rpc.customerPlaceOrder.mockResolvedValue({
    replayed: false,
    bill_token_issued: true,
    order: { id: table_id },
    bill: { id: table_id },
  });
  rpc.customerGetBill.mockResolvedValue({
    view: "table",
    table_in_use: true,
    bill: null,
    orders: [],
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it("QR binary layout, canonical encoding, tampering and per-store hashes", () => {
  expect(verifyTableCode(code)).toEqual(table);
  expect(Buffer.from(code.split(".")[1], "base64url")).toHaveLength(34);
  expect(verifyTableCode(code.slice(0, -2) + "AA")).toBeNull();
  expect(verifyTableCode("v2." + code.slice(3))).toBeNull();
  expect(clientHash(store_id, "device")).not.toBe(
    clientHash(table_id, "device"),
  );
  expect(requestHash(table_id, items)).toBe(
    requestHash(
      table_id,
      items.map((i) => ({ ...i })),
    ),
  );
  expect(requestHash(store_id, items)).not.toBe(requestHash(table_id, items));
});
it("trusted context ignores self-reported headers and rejects bad signatures", () => {
  expect(device(req())).toBe(did);
  expect(
    device(
      req(undefined, {
        cookie: `did=${did.slice(0, -2)}AA`,
        "X-Device-Id": did,
      }),
    ),
  ).toBeNull();
  expect(trustedIp(req(undefined, { "x-forwarded-for": "203.0.113.2" }))).toBe(
    "192.0.2.1",
  );
  expect(
    trustedIp(
      new Request("https://site.example.invalid", {
        headers: { "x-forwarded-for": "203.0.113.2" },
      }),
    ),
  ).toBe("unknown");
});
it("C1 issues secure did and preserves closed-store menu; all responses no-store", async () => {
  const response = await menu(req(undefined, { cookie: "" }), context());
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(response.headers.get("set-cookie")).toMatch(
    /did=v1\..*HttpOnly; Secure; SameSite=Strict; Path=\/api\/t; Max-Age=31536000/,
  );
  expect((await response.json()).store.is_accepting_orders).toBe(false);
  expect((await menu(req(), context())).headers.get("set-cookie")).toBeNull();
});
it("21st invalid QR is limited despite forged XFF", async () => {
  code = "tampered";
  for (let i = 0; i < 21; i++) {
    const response = await menu(
      req(undefined, { "x-forwarded-for": `203.0.113.${i}` }),
      context(),
    );
    expect(response.status).toBe(i < 20 ? 404 : 429);
    expect(await err(response)).toBe(i < 20 ? "TABLE_INVALID" : "RATE_LIMITED");
  }
  expect(rpc.customerGetMenu).not.toHaveBeenCalled();
});
it.each(
  Object.entries(scopes).filter(
    ([s]) => !["orderStore", "orderIp", "orderTable"].includes(s),
  ),
)("scope %s enforces limit and window", async (scope, [max, window]) => {
  let now = 0;
  const limiter = new MemoryRateLimiter(() => now);
  for (let i = 0; i < max; i++)
    await expect(
      limit(scope as keyof typeof scopes, "key", limiter),
    ).resolves.toBe(false);
  await expect(
    limit(scope as keyof typeof scopes, "key", limiter),
  ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  now = window;
  await expect(
    limit(scope as keyof typeof scopes, "key", limiter),
  ).resolves.toBe(false);
});
it("IP 21 requires captcha; 101 rejects even captcha; store 121 requires captcha", async () => {
  const ip = clientHash(store_id, "192.0.2.1");
  for (let i = 0; i < 20; i++) await limit("orderIp", ip);
  expect(await err(await order(req(body()), context()))).toBe(
    "CAPTCHA_REQUIRED",
  );
  const response = await order(req(body("test-token")), context());
  expect(response.status).toBe(201);
  expect(rpc.customerPlaceOrder.mock.lastCall?.[0].captcha_verified).toBe(true);
  for (let i = 22; i < 100; i++) await limit("orderIp", ip);
  expect(await err(await order(req(body("test-token")), context()))).toBe(
    "RATE_LIMITED",
  );
  for (let i = 0; i < 120; i++) await limit("orderStore", "other-store");
  expect(await limit("orderStore", "other-store")).toBe(true);
});
it("fourth device order rejects despite spoofed device ID; retries use 200", async () => {
  for (let i = 0; i < 3; i++)
    expect(
      (await order(req(body(), { "X-Device-Id": `fake-${i}` }), context()))
        .status,
    ).toBe(201);
  expect(
    await err(await order(req(body(), { "X-Device-Id": "new" }), context())),
  ).toBe("RATE_LIMITED");
  memory = new MemoryRateLimiter();
  rpc.customerPlaceOrder.mockResolvedValue({
    replayed: true,
    bill_token_issued: false,
  });
  const response = await order(req(body()), context());
  expect(response.status).toBe(200);
  expect((await response.json()).replayed).toBe(true);
  expect(response.headers.get("set-cookie")).toBeNull();
});
it("C3 passes hashes only, uses 32-byte token cookie and omits token from body", async () => {
  const response = await order(
    req(body(), {
      cookie: `did=${did}; ${billCookieName(table_id)}=old-token`,
    }),
    context(),
  );
  expect(response.status).toBe(201);
  const value = response.headers.get("set-cookie")!;
  const token = value.split(";")[0].split("=")[1];
  expect(Buffer.from(token, "base64url")).toHaveLength(32);
  expect(value).toContain("Max-Age=43200");
  expect(value).toContain("HttpOnly; Secure; SameSite=Strict; Path=/api/t");
  expect(rpc.customerPlaceOrder.mock.lastCall?.[0]).toMatchObject({
    bill_token_hash: sha256("old-token"),
    new_bill_token_hash: sha256(token),
    request_hash: requestHash(table_id, items),
    captcha_verified: false,
  });
  expect(await response.text()).not.toContain(token);
});
it.each([
  { success: false },
  { success: true, action: "login", hostname: "site.example.invalid" },
  { success: true, action: "place_order", hostname: "evil.invalid" },
])("Turnstile rejects %j", async (result) => {
  vi.mocked(fetch).mockResolvedValue(Response.json(result));
  expect(await err(await order(req(body("test-token")), context()))).toBe(
    "CAPTCHA_FAILED",
  );
  expect(rpc.customerPlaceOrder).not.toHaveBeenCalled();
});
it("Turnstile missing secret/token/network error fails closed", async () => {
  await expect(verifyTurnstile()).rejects.toMatchObject({
    code: "CAPTCHA_REQUIRED",
  });
  vi.stubEnv("TURNSTILE_SECRET_KEY", "");
  await expect(verifyTurnstile("test-token")).rejects.toMatchObject({
    code: "CAPTCHA_FAILED",
  });
  expect(fetch).not.toHaveBeenCalled();
  vi.stubEnv("TURNSTILE_SECRET_KEY", "1x0000000000000000000000000000000AA");
  vi.mocked(fetch).mockRejectedValue(new Error("offline"));
  await expect(verifyTurnstile("test-token")).rejects.toMatchObject({
    code: "CAPTCHA_FAILED",
  });
});
it("Redis unavailable requires captcha for orders, rejects other scopes", async () => {
  vi.mocked(rateLimiter.hit).mockRejectedValue(new Error("offline"));
  expect(await err(await order(req(body()), context()))).toBe(
    "CAPTCHA_REQUIRED",
  );
  expect((await order(req(body("test-token")), context())).status).toBe(201);
  expect((await menu(req(), context())).status).toBe(429);
});
it("quote preserves estimates/limit fields and rejects malformed bodies and absent did", async () => {
  const value = {
    can_order: false,
    limit_exceeded: true,
    estimated_total_cents: null,
    estimate_basis: "this_order",
  };
  rpc.customerQuote.mockResolvedValue(value);
  expect(await (await quote(req({ items }), context())).json()).toEqual(value);
  expect(rpc.customerQuote).toHaveBeenCalledWith(table, items);
  expect(
    await err(
      await quote(req({ items: [{ ...items[0], quantity: 0 }] }), context()),
    ),
  ).toBe("VALIDATION_FAILED");
  expect(
    await err(
      await order(req(body(), { cookie: "", "X-Device-Id": did }), context()),
    ),
  ).toBe("VALIDATION_FAILED");
  expect(
    await err(
      await quote(req({ items }, { "content-type": "text/plain" }), context()),
    ),
  ).toBe("UNSUPPORTED_MEDIA_TYPE");
});
it.each([
  "STORE_CLOSED",
  "PRICE_CHANGED",
  "ITEM_UNAVAILABLE",
  "STORE_SUSPENDED",
] as const)("RPC business error %s remains mapped", async (code) => {
  rpc.customerPlaceOrder.mockRejectedValue(new AppError(code));
  expect(await err(await order(req(body()), context()))).toBe(code);
});
it("bill hashes cookies and supports anonymous table-only view", async () => {
  expect((await bill(req(), context())).status).toBe(200);
  expect(rpc.customerGetBill.mock.lastCall?.[1]).toBeNull();
  await bill(
    req(undefined, {
      cookie: `did=${did}; ${billCookieName(table_id)}=private-token`,
    }),
    context(),
  );
  expect(rpc.customerGetBill).toHaveBeenLastCalledWith(
    table,
    sha256("private-token"),
    clientHash(store_id, did),
  );
});
it.each(["bill_paid", "qr_rotated", "expired"])(
  "bill 410 %s clears cookie",
  async (reason) => {
    rpc.customerGetBill.mockRejectedValue(
      Object.assign(new AppError("BILL_TOKEN_EXPIRED"), {
        details: { reason },
      }),
    );
    const response = await bill(req(), context());
    expect(response.status).toBe(410);
    expect((await response.json()).error.details).toEqual({ reason });
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  },
);
it("store threshold also requires Turnstile through C3", async () => {
  for (let i = 0; i < 120; i++) await limit("orderStore", store_id);
  expect(await err(await order(req(body()), context()))).toBe(
    "CAPTCHA_REQUIRED",
  );
  expect((await order(req(body("test-token")), context())).status).toBe(201);
});
it("RPC-invalid signed QR counts towards invalid-code IP limit", async () => {
  rpc.customerGetMenu.mockRejectedValue(new AppError("TABLE_INVALID"));
  for (let i = 0; i < 21; i++)
    expect((await menu(req(), context())).status).toBe(i < 20 ? 404 : 429);
});
it("C4 rejects token ownership mismatch via RPC and preserves own-orders payload", async () => {
  rpc.customerGetBill.mockRejectedValueOnce(new AppError("BILL_TOKEN_INVALID"));
  expect((await bill(req(), context())).status).toBe(401);
  const payload = {
    view: "bill",
    scope: "own_orders",
    bill: { amounts_basis: "own_orders" },
    orders: [{ id: table_id }],
  };
  rpc.customerGetBill.mockResolvedValue(payload);
  expect(await (await bill(req(), context())).json()).toEqual(payload);
});

it("table sixth order needs no captcha; seventh and later require it, valid token succeeds, window resets", async () => {
  let now = 0;
  memory = new MemoryRateLimiter(() => now);
  for (let i = 1; i <= 6; i++) {
    did = issueDevice();
    expect((await order(req(body()), context())).status).toBe(201);
    expect(rpc.customerPlaceOrder.mock.lastCall?.[0].captcha_verified).toBe(
      false,
    );
  }
  expect(fetch).not.toHaveBeenCalled();
  for (let i = 7; i <= 8; i++) {
    did = issueDevice();
    expect(await err(await order(req(body()), context()))).toBe(
      "CAPTCHA_REQUIRED",
    );
  }
  expect(rpc.customerPlaceOrder).toHaveBeenCalledTimes(6);
  did = issueDevice();
  expect((await order(req(body("test-token")), context())).status).toBe(201);
  expect(rpc.customerPlaceOrder.mock.lastCall?.[0].captcha_verified).toBe(true);
  now = scopes.orderTable[1];
  did = issueDevice();
  expect((await order(req(body()), context())).status).toBe(201);
  expect(rpc.customerPlaceOrder.mock.lastCall?.[0].captcha_verified).toBe(
    false,
  );
});
it.each(Object.keys(scopes))(
  "scope %s keeps fail-closed behavior on limiter failure",
  async (scope) => {
    const failing = { hit: vi.fn().mockRejectedValue(new Error("offline")) };
    const pending = limit(scope as keyof typeof scopes, "key", failing);
    if (scope.startsWith("order")) await expect(pending).resolves.toBe(true);
    else await expect(pending).rejects.toMatchObject({ code: "RATE_LIMITED" });
  },
);
