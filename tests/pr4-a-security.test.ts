import { afterEach, beforeEach, expect, it, vi } from "vitest";
const rpc = vi.hoisted(() => ({
  customerPlaceOrder: vi.fn(),
  customerCheckReplay: vi.fn(),
  customerQuote: vi.fn(),
}));
vi.mock("../lib/supabase/customer", () => rpc);
import { POST as order } from "../app/api/t/[code]/orders/route";
import { POST as quote } from "../app/api/t/[code]/quote/route";
import { trustedIp, issueDevice } from "../lib/client-context";
import { signTableCode } from "../lib/qr";
import { rateLimiter, MemoryRateLimiter, limit } from "../lib/ratelimit";
import { verifyTurnstile } from "../lib/turnstile";
import { AppError, toErrorResponse } from "../lib/api/errors";
import { cartBody } from "../lib/api/schemas";
const table = {
  store_id: "11111111-1111-4111-8111-111111111111",
  table_id: "22222222-2222-4222-8222-222222222222",
  qr_version: 1,
};
const binding = { table_id: table.table_id, request_id: table.store_id };
const items = [{ item_id: table.table_id, quantity: 1, unit_price_cents: 100 }];
let did: string, code: string;
const req = (
  body: BodyInit = JSON.stringify({
    items,
    client_request_id: binding.request_id,
  }),
  headers = {},
) =>
  new Request("https://site.example.invalid/api/t/code", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: `did=${did}`,
      ...headers,
    },
    body,
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  });
const context = () => ({ params: Promise.resolve({ code }) });
beforeEach(() => {
  vi.stubEnv("QR_SIGNING_SECRET", "test-qr");
  vi.stubEnv("DEVICE_COOKIE_SECRET", "test-device");
  vi.stubEnv("CLIENT_HASH_SECRET", "test-hash");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://site.example.invalid");
  did = issueDevice();
  code = signTableCode(table);
  const memory = new MemoryRateLimiter();
  vi.spyOn(rateLimiter, "hit").mockImplementation((k, w) => memory.hit(k, w));
  rpc.customerCheckReplay.mockResolvedValue({ status: "missing" });
  rpc.customerPlaceOrder.mockResolvedValue({
    replayed: false,
    bill_token_issued: false,
  });
  rpc.customerQuote.mockResolvedValue({});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
it.each([
  ["192.0.2.1", "192.0.2.1"],
  ["2001:0db8:abcd:0012:0000:0000:0000:0001", "2001:db8:abcd:12::/64"],
  ["2001:db8:abcd:12::ffff", "2001:db8:abcd:12::/64"],
  ["::ffff:192.0.2.1", "192.0.2.1"],
  ["0:0:0:0:0:ffff:c000:201", "192.0.2.1"],
  ["::1", "0:0:0:0::/64"],
  ["invalid", "unknown"],
  ["fe80::1%eth0", "unknown"],
  ["192.0.2.1,192.0.2.2", "unknown"],
])("trusted IP %s normalizes to %s", (ip, expected) => {
  expect(
    trustedIp(
      new Request("https://site.example.invalid", {
        headers: { "x-vercel-forwarded-for": ip },
      }),
    ),
  ).toBe(expected);
});
it("production ignores x-real-ip and malformed Vercel headers never fall back", () => {
  vi.stubEnv("NODE_ENV", "production");
  expect(trustedIp(req(undefined, { "x-real-ip": "192.0.2.1" }))).toBe(
    "unknown",
  );
  expect(
    trustedIp(
      req(undefined, {
        "x-real-ip": "192.0.2.1",
        "x-vercel-forwarded-for": "bad",
      }),
    ),
  ).toBe("unknown");
});
it("confirmed database replay returns 200 without any rate hits, CAPTCHA or new order", async () => {
  rpc.customerCheckReplay.mockResolvedValue({ status: "replay" });
  rpc.customerPlaceOrder.mockResolvedValue({
    replayed: true,
    bill_token_issued: false,
  });
  vi.mocked(rateLimiter.hit).mockRejectedValue(new Error("offline"));
  for (let i = 0; i < 25; i++)
    expect((await order(req(), context())).status).toBe(200);
  expect(rateLimiter.hit).not.toHaveBeenCalled();
  expect(rpc.customerPlaceOrder).toHaveBeenCalledTimes(25);
});
it("random IDs cannot bypass device hard limit", async () => {
  for (let i = 0; i < 4; i++) {
    const r = await order(
      req(
        JSON.stringify({
          items,
          client_request_id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        }),
      ),
      context(),
    );
    expect(r.status).toBe(i < 3 ? 201 : 429);
  }
  expect(rpc.customerPlaceOrder).toHaveBeenCalledTimes(3);
});
it.each(["table_db", "ip_db"])(
  "new submissions retain database hard limit %s",
  async (scope) => {
    rpc.customerPlaceOrder.mockRejectedValue(
      new AppError("RATE_LIMITED", { scope, retry_after_seconds: 120 }),
    );
    const r = await order(req(), context());
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("120");
  },
);
it("application CAPTCHA_REQUIRED includes documented scope", async () => {
  await limit("orderTable", table.table_id);
  for (let i = 0; i < 5; i++) await limit("orderTable", table.table_id);
  const r = await order(req(), context());
  expect((await r.json()).error.details).toEqual({ scope: "table" });
});
it("customer suspension wording is isolated from shared merchant errors", async () => {
  rpc.customerPlaceOrder.mockRejectedValue(new AppError("STORE_SUSPENDED"));
  expect((await (await order(req(), context())).json()).error.message).toBe(
    "本店暂停服务",
  );
  expect(
    (await toErrorResponse(new AppError("STORE_SUSPENDED")).json()).error
      .message,
  ).toBe("店铺已被平台停用，请联系平台");
});
it.each([0, 0.2, 120.1])(
  "Retry-After rounds %s up with a minimum of 1",
  (n) => {
    expect(
      toErrorResponse(
        new AppError("RATE_LIMITED", { retry_after_seconds: n }),
      ).headers.get("retry-after"),
    ).toBe(String(Math.max(1, Math.ceil(n))));
  },
);
it("limiter supplies scope window seconds instead of fixed 60", async () => {
  const limiter = { hit: async () => 101 };
  try {
    await limit("orderIp", "key", limiter);
    throw Error("unexpected");
  } catch (e) {
    expect(toErrorResponse(e).headers.get("retry-after")).toBe("600");
  }
});
it.each(["declared", "streamed", "lying"])(
  "16 KB limit rejects %s oversized bodies before JSON parsing and database",
  async (mode) => {
    const payload = "x".repeat(16385);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(payload.slice(0, 8192)));
        c.enqueue(new TextEncoder().encode(payload.slice(8192)));
        c.close();
      },
    });
    const request = req(
      mode === "declared" ? payload : stream,
      mode === "declared"
        ? { "content-length": "16385" }
        : mode === "lying"
          ? { "content-length": "1" }
          : {},
    );
    expect((await quote(request, context())).status).toBe(413);
    expect(rpc.customerQuote).not.toHaveBeenCalled();
  },
);
it("16 KB exact valid JSON is accepted, malformed small JSON stays 400", async () => {
  const body = JSON.stringify({ items });
  await expect(
    cartBody(req(body + " ".repeat(16384 - Buffer.byteLength(body)))),
  ).resolves.toMatchObject({ items });
  await expect(cartBody(req("{"))).rejects.toMatchObject({
    code: "VALIDATION_FAILED",
  });
});
it.each([undefined, "wrong", `${table.table_id}_${table.table_id}`])(
  "production secret rejects mismatching cdata %s",
  async (cdata) => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "unit-production-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          success: true,
          action: "place_order",
          hostname: "site.example.invalid",
          cdata,
        }),
      ),
    );
    await expect(verifyTurnstile("token", binding)).rejects.toMatchObject({
      code: "CAPTCHA_FAILED",
    });
  },
);
it("matching cdata and request idempotency key are enforced", async () => {
  vi.stubEnv("TURNSTILE_SECRET_KEY", "unit-production-secret");
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({
      success: true,
      action: "place_order",
      hostname: "site.example.invalid",
      cdata: `${binding.table_id}_${binding.request_id}`,
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  await expect(verifyTurnstile("token", binding)).resolves.toBe(true);
  expect(fetcher.mock.calls[0][1].body.get("idempotency_key")).toBe(
    binding.request_id,
  );
});
it("exact official test secret allows missing cdata but retains hostname/action verification", async () => {
  vi.stubEnv("TURNSTILE_SECRET_KEY", "1x0000000000000000000000000000000AA");
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
  await expect(verifyTurnstile("token", binding)).resolves.toBe(true);
  vi.mocked(fetch).mockResolvedValue(
    Response.json({ success: true, action: "login", hostname: "evil.invalid" }),
  );
  await expect(verifyTurnstile("token", binding)).rejects.toMatchObject({
    code: "CAPTCHA_FAILED",
  });
});

it("production order route binds token to signed table and request, ignoring client cdata", async () => {
  vi.stubEnv("TURNSTILE_SECRET_KEY", "unit-production-secret");
  const fetcher = vi.fn().mockResolvedValue(
    Response.json({
      success: true,
      action: "place_order",
      hostname: "site.example.invalid",
      cdata: `${table.table_id}_${binding.request_id}`,
    }),
  );
  vi.stubGlobal("fetch", fetcher);
  const response = await order(
    req(
      JSON.stringify({
        items,
        client_request_id: binding.request_id,
        captcha_token: "token",
        cdata: "untrusted",
      }),
    ),
    context(),
  );
  expect(response.status).toBe(201);
  expect(rpc.customerPlaceOrder.mock.lastCall?.[0].captcha_verified).toBe(true);
  expect(fetcher.mock.calls[0][1].body.get("idempotency_key")).toBe(
    binding.request_id,
  );
});
it("orders reject a streamed oversized UTF-8 body by bytes before replay probing", async () => {
  const payload = JSON.stringify({
    items,
    client_request_id: binding.request_id,
    padding: "汉".repeat(6000),
  });
  expect(payload.length).toBeLessThan(16384);
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(payload));
      c.close();
    },
  });
  const r = await order(req(stream), context());
  expect(r.status).toBe(413);
  expect((await r.json()).error.code).toBe("PAYLOAD_TOO_LARGE");
  expect(rpc.customerCheckReplay).not.toHaveBeenCalled();
  expect(rpc.customerPlaceOrder).not.toHaveBeenCalled();
});
it("JSON body stream read errors fail closed before the database", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.error(new Error("stream failed"));
    },
  });
  const r = await order(req(stream), context());
  expect(r.status).toBe(400);
  expect(rpc.customerCheckReplay).not.toHaveBeenCalled();
});

it("hard-limited requests run only the read-only check", async () => {
  vi.mocked(rateLimiter.hit).mockResolvedValue(10000);
  expect((await order(req(), context())).status).toBe(429);
  expect(rpc.customerCheckReplay).toHaveBeenCalledOnce();
  expect(rpc.customerPlaceOrder).not.toHaveBeenCalled();
});
it("check infrastructure errors fail closed before rates or writes", async () => {
  rpc.customerCheckReplay.mockRejectedValue(new AppError("INTERNAL"));
  expect((await order(req(), context())).status).toBe(503);
  expect(rateLimiter.hit).not.toHaveBeenCalled();
  expect(rpc.customerPlaceOrder).not.toHaveBeenCalled();
});
it("check mismatch preserves conflict semantics", async () => {
  rpc.customerCheckReplay.mockResolvedValue({
    status: "mismatch",
    code: "IDEMPOTENCY_KEY_REUSED",
  });
  expect((await order(req(), context())).status).toBe(409);
  expect(rateLimiter.hit).not.toHaveBeenCalled();
  expect(rpc.customerPlaceOrder).not.toHaveBeenCalled();
});
it("explicit local forwarded IP uses first address and IPv6 normalization", () => {
  vi.stubEnv("TRUST_LOCAL_IP", "1");
  expect(
    trustedIp(
      req(undefined, { "x-forwarded-for": "2001:db8:abcd:12::1, 192.0.2.1" }),
    ),
  ).toBe("2001:db8:abcd:12::/64");
  expect(trustedIp(req(undefined, { "x-real-ip": "192.0.2.1" }))).toBe(
    "192.0.2.1",
  );
});
it.each(["NODE_ENV", "VERCEL_ENV"])(
  "%s production ignores local override",
  (env) => {
    vi.stubEnv("TRUST_LOCAL_IP", "1");
    vi.stubEnv(env, "production");
    expect(
      trustedIp(
        req(undefined, {
          "x-forwarded-for": "192.0.2.1",
          "x-real-ip": "192.0.2.2",
        }),
      ),
    ).toBe("unknown");
  },
);
