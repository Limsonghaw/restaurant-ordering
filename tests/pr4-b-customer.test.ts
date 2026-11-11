import { afterEach, expect, it, vi } from "vitest";
import { getTableMenu, quoteCart } from "../lib/data/supabase/menu";
import { placeOrder, getTableBill } from "../lib/data/supabase/orders";
afterEach(() => vi.unstubAllGlobals());
it("calls all four same-origin routes without caching and translates turnstile_token", async () => {
  const fetch = vi
    .fn()
    .mockImplementation(async () => Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetch);
  await getTableMenu("a/b");
  await quoteCart("code", []);
  await placeOrder("code", {
    client_request_id: "request",
    items: [],
    turnstile_token: "challenge",
  });
  await getTableBill("code");
  expect(fetch.mock.calls.map((c) => c[0])).toEqual([
    "/api/t/a%2Fb/menu",
    "/api/t/code/quote",
    "/api/t/code/orders",
    "/api/t/code/bill",
  ]);
  for (const call of fetch.mock.calls)
    expect(call[1]).toMatchObject({
      credentials: "same-origin",
      cache: "no-store",
    });
  expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({
    client_request_id: "request",
    items: [],
    captcha_token: "challenge",
  });
});
it.each([
  [410, "BILL_TOKEN_EXPIRED", { reason: "bill_paid" }],
  [403, "CAPTCHA_REQUIRED", { scope: "store" }],
  [
    409,
    "PRICE_CHANGED",
    { price_changes: [{ current_unit_price_cents: 120 }] },
  ],
])("preserves status %s and details", async (status, code, details) => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { error: { code, message: "提示", details } },
          { status: status as number, headers: { "Retry-After": "30" } },
        ),
      ),
  );
  await expect(getTableBill("code")).rejects.toMatchObject({
    code,
    details,
    status,
    retryAfterSeconds: 30,
  });
});
it("maps failed fetch to NETWORK", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
  await expect(getTableMenu("code")).rejects.toMatchObject({ code: "NETWORK" });
});
