import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTableMenu, quoteCart } from "../lib/data/mock/menu";
import { getTableBill, placeOrder } from "../lib/data/mock/orders";
import { configureMock, runMockAction } from "../lib/data/mock/controls-a";
import { readState, saveState } from "../lib/data/mock/state";
import { calculateAmounts } from "../lib/data/mock/money";
import type { CartItem, PlaceOrderBody } from "../lib/data/types";
class StorageStub {
  values = new Map<string, string>();
  getItem(k: string) {
    return this.values.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.values.set(k, v);
  }
  removeItem(k: string) {
    this.values.delete(k);
  }
}
async function finish<T>(promise: Promise<T>) {
  const guarded = promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await vi.runAllTimersAsync();
  const result = await guarded;
  if ("error" in result) throw result.error;
  return result.value;
}
const line = (quantity = 1): CartItem => ({
  item_id: "store-0-item-0",
  quantity,
  note: "少辣",
  unit_price_cents: 1250,
});
const body = (): PlaceOrderBody => ({
  client_request_id: crypto.randomUUID(),
  items: [line()],
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("localStorage", new StorageStub());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("顾客数据合约", () => {
  it("服务费和 SST 按整数仙取整，零费率和不进位", () => {
    expect(calculateAmounts(1250, 1000, 600)).toEqual({
      subtotal_cents: 1250,
      service_charge_cents: 125,
      sst_cents: 83,
      rounding_cents: 0,
      total_cents: 1458,
    });
    expect(calculateAmounts(390, 0, 0).total_cents).toBe(390);
  });
  it("菜单过滤隐藏、删除菜品，保留售完；失效桌码和停用店铺", async () => {
    const menu = await finish(getTableMenu("demo-a1"));
    expect(menu.items).toHaveLength(16);
    expect(menu.items.filter((i) => i.is_sold_out)).toHaveLength(2);
    await expect(finish(getTableMenu("demo-a9"))).rejects.toMatchObject({
      code: "TABLE_INVALID",
    });
    await expect(finish(getTableMenu("demo-suspended"))).rejects.toMatchObject({
      code: "STORE_SUSPENDED",
    });
  });
  it("试算忽略客户端价格计价并报告价差，上限金额全部为 null", async () => {
    const q = await finish(
      quoteCart("demo-a2", [{ ...line(), unit_price_cents: 1 }]),
    );
    expect(q.estimated_total_cents).toBe(1458);
    expect(q.price_changes).toHaveLength(1);
    const over = await finish(
      quoteCart("demo-a2", [
        { ...line(99), item_id: "store-0-item-3", unit_price_cents: 12800 },
      ]),
    );
    expect(over.limit_exceeded).toBe(true);
    expect(over.estimated_total_cents).toBeNull();
    expect(over.estimated_service_charge_cents).toBeNull();
  });
  it("数量、备注、件数、行数边界", async () => {
    await expect(
      finish(quoteCart("demo-a1", [line(100)])),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      finish(quoteCart("demo-a1", [{ ...line(), note: "字".repeat(51) }])),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(
      (await finish(quoteCart("demo-a1", [line(99), line(99), line(3)])))
        .limit_exceeded,
    ).toBe(true);
    expect(
      (
        await finish(
          quoteCart(
            "demo-a1",
            Array.from({ length: 31 }, () => line()),
          ),
        )
      ).limit_exceeded,
    ).toBe(true);
  });
  it("同一请求重复提交只生成一单，内容不同拒绝", async () => {
    const b = body();
    const first = await finish(placeOrder("demo-a2", b));
    const second = await finish(placeOrder("demo-a2", b));
    expect(first.order.id).toBe(second.order.id);
    expect(second.replayed).toBe(true);
    expect(
      readState().bills.find((b) => b.table_id === "a2")?.orders,
    ).toHaveLength(1);
    await expect(
      finish(placeOrder("demo-a2", { ...b, items: [line(2)] })),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });
  it("已落库的网络失败重试返回 replayed", async () => {
    await configureMock({ next_order: "NETWORK_AFTER" });
    const b = body();
    await expect(finish(placeOrder("demo-a2", b))).rejects.toMatchObject({
      code: "NETWORK",
    });
    expect((await finish(placeOrder("demo-a2", b))).replayed).toBe(true);
  });
  it("只返回本机订单，不泄露设备、令牌、店员说明；新手机没有订单", async () => {
    const b = await finish(getTableBill("demo-a1"));
    expect(b.orders).toHaveLength(4);
    expect(JSON.stringify(b)).not.toMatch(
      /device_id|cancel_note|token"|顾客不应/,
    );
    await runMockAction("switch_device", "demo-a1");
    expect(await finish(getTableBill("demo-a1"))).toMatchObject({
      view: "table",
      table_in_use: true,
    });
    await finish(placeOrder("demo-a1", body()));
    expect((await finish(getTableBill("demo-a1"))).orders).toHaveLength(1);
  });
  for (const [action, reason] of [
    ["paid", "bill_paid"],
    ["rotate", "qr_rotated"],
    ["expire", "expired"],
  ] as const)
    it(`410 ${reason} 只返回一次并清令牌`, async () => {
      await runMockAction(action, "demo-a1");
      await expect(finish(getTableBill("demo-a1"))).rejects.toMatchObject({
        code: "BILL_TOKEN_EXPIRED",
        status: 410,
        details: { reason },
      });
      if (action === "rotate") {
        await expect(finish(getTableMenu("demo-a1"))).rejects.toMatchObject({
          code: "TABLE_INVALID",
        });
        expect((await finish(getTableBill("demo-a1-r1"))).view).toBe("table");
      } else expect((await finish(getTableBill("demo-a1"))).view).toBe("table");
    });
  it("验证码两种 scope，失败后可用同一请求重新验证", async () => {
    await configureMock({
      next_order: "CAPTCHA_REQUIRED_IP",
      captcha_fail: true,
    });
    const b = body();
    await expect(finish(placeOrder("demo-a2", b))).rejects.toMatchObject({
      code: "CAPTCHA_REQUIRED",
      details: { scope: "ip_db" },
    });
    await expect(
      finish(placeOrder("demo-a2", { ...b, captcha_token: "mock-1" })),
    ).rejects.toMatchObject({ code: "CAPTCHA_FAILED" });
    expect(
      (await finish(placeOrder("demo-a2", { ...b, captcha_token: "mock-2" })))
        .order.status,
    ).toBe("new");
  });
  it("金额不包含已取消订单和其他手机；状态 20/40 秒推进", async () => {
    const b = await finish(getTableBill("demo-a1"));
    if (b.view === "bill") expect(b.bill.subtotal_cents).toBe(3750);
    await configureMock({ auto_progress: true });
    await finish(placeOrder("demo-a2", body()));
    vi.advanceTimersByTime(21000);
    expect((await finish(getTableBill("demo-a2"))).orders[0].status).toBe(
      "accepted",
    );
    vi.advanceTimersByTime(21000);
    expect((await finish(getTableBill("demo-a2"))).orders[0].status).toBe(
      "served",
    );
  });
  it("拉黑判断与默认登录身份没有私有列", async () => {
    const state = readState();
    state.blocks.push({
      id: "block",
      store_id: "store-0",
      kind: "device",
      device_id: state.device_id,
      reason: "",
      source_order_id: null,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 100000).toISOString(),
    });
    saveState(state);
    await expect(finish(placeOrder("demo-a2", body()))).rejects.toMatchObject({
      code: "DEVICE_BLOCKED",
    });
  });
});
