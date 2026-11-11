import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataError } from "../lib/data/types";
import { billGoneState } from "../lib/ui/customer-errors-d";
import { errorMessage } from "../lib/format";
import { readFileSync } from "node:fs";
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
async function finish<T>(p: Promise<T>) {
  const guarded = p.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await vi.runAllTimersAsync();
  const r = await guarded;
  if ("error" in r) throw r.error;
  return r.value;
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", "mock");
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("localStorage", new StorageStub());
  const d = await import("../lib/data");
  await d.authMockAction("identity", "owner");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
// All reads/writes go through the unified export, including tests of persistence.
const data = () => import("../lib/data");
describe("PR-D 顾客遗留修复", () => {
  it.each([
    ["qr_rotated", "二维码已更新，请重新扫码"],
    ["bill_paid", "已结账，谢谢光临"],
    ["expired", "页面已过期，请重新扫码"],
    ["something-new", "页面已失效，请重新扫码"],
  ])(
    "410 %s uses code/reason, never message, and stops polling",
    (reason, message) => {
      for (const text of ["任意错误文字", "已结账", "二维码已更新"]) {
        expect(
          billGoneState(
            new DataError("BILL_TOKEN_EXPIRED", text, { reason }, 410),
          ),
        ).toMatchObject({ message, stopPolling: true });
      }
    },
  );
  it("其他 410 不能凭 reason 或文字伪装为已更新；非410继续通常错误处理", () => {
    expect(
      billGoneState(
        new DataError(
          "NOT_FOUND",
          "二维码已更新",
          { reason: "qr_rotated" },
          410,
        ),
      ),
    ).toEqual({
      reason: "unknown",
      message: "页面已失效，请重新扫码",
      stopPolling: true,
    });
    expect(
      billGoneState(new DataError("BILL_TOKEN_EXPIRED", "expired", {}, 410))
        ?.stopPolling,
    ).toBe(true);
    expect(
      billGoneState(
        new DataError("NETWORK", "二维码已更新", { reason: "qr_rotated" }, 503),
      ),
    ).toBeUndefined();
    const source = readFileSync("lib/ui/customer.tsx", "utf8");
    expect(source).toContain("const terminal = billGoneState(e)");
    expect(source).toContain("stopped = terminal.stopPolling");
    expect(source).toContain("setGone(terminal)");
  });
  it("logo 复用 FoodImage，组件包含无图/加载失败占位", () => {
    const source = readFileSync("lib/ui/customer.tsx", "utf8"),
      common = readFileSync("lib/ui/common.tsx", "utf8");
    expect(source).toMatch(/<FoodImage[\s\S]*?path=\{menu.store.logo_path\}/);
    expect(common).toContain("onError={() => setFailed(true)}");
    expect(common).toContain('aria-label="暂无图片"');
  });
  it("菜单按 sort_order 排序；同值 id 升序；分类跨店不共享 id", async () => {
    const d = await data();
    const a = await finish(d.getTableMenu("demo-a1"));
    const b = await finish(d.getTableMenu("demo-b1"));
    expect(
      a.categories.every((c) => !b.categories.some((x) => x.id === c.id)),
    ).toBe(true);
    expect(new Set(a.categories.map((c) => c.id)).size).toBe(
      a.categories.length,
    );
    const key = "ro-mock:state-v2",
      s = JSON.parse(localStorage.getItem(key)!);
    // Force reverse order and tied sort_order in persistent fixture, then exercise public C1.
    s.categories.reverse();
    s.items.reverse();
    s.categories.forEach((c: { sort_order: number }) => (c.sort_order = 1));
    s.items.forEach((i: { sort_order: number }) => (i.sort_order = 2));
    localStorage.setItem(key, JSON.stringify(s));
    const sorted = await finish(d.getTableMenu("demo-a1"));
    expect(sorted.categories.map((c) => c.id)).toEqual(
      sorted.categories.map((c) => c.id).sort((a, b) => a.localeCompare(b)),
    );
    expect(sorted.items.map((i) => i.id)).toEqual(
      sorted.items.map((i) => i.id).sort((a, b) => a.localeCompare(b)),
    );
    for (const store of s.stores) {
      const ids = s.categories
        .filter((c: { store_id: string }) => c.store_id === store.id)
        .map((c: { id: string }) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
    const all = s.categories.map((c: { id: string }) => c.id);
    expect(new Set(all).size).toBe(all.length);
  });
  it("顾客店铺停用统一文案；店家文案不受影响", async () => {
    const d = await data();
    await d.runMockAction("suspend", "demo-a1");
    const error = await finish(d.getTableMenu("demo-a1")).catch((e) => e);
    expect(error.code).toBe("STORE_SUSPENDED");
    expect(errorMessage(error)).toBe("本店暂停服务");
    expect(
      errorMessage(
        new DataError("STORE_SUSPENDED", "店铺已被平台停用，请联系平台"),
      ),
    ).toBe("本店暂停服务");
    expect(readFileSync("lib/ui/store-shell.tsx", "utf8")).toContain(
      "店铺已被平台停用，请联系平台",
    );
  });
});
describe("PR-D P6 账单", () => {
  it("固定20条分页、独立已付/未付列表及主要错误", async () => {
    const d = await data();
    await finish(d.storeMockActionD("many_bills"));
    expect(await finish(d.listStoreBills("paid", 1))).toMatchObject({
      total: 45,
      page_size: 20,
      bills: expect.any(Array),
    });
    expect((await finish(d.listStoreBills("paid", 1))).bills).toHaveLength(20);
    expect((await finish(d.listStoreBills("paid", 2))).bills).toHaveLength(20);
    expect((await finish(d.listStoreBills("paid", 3))).bills).toHaveLength(5);
    expect((await finish(d.listStoreBills("open"))).bills).toHaveLength(1);
    await expect(finish(d.listStoreBills("open", 0))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(finish(d.getStoreBill("bill-b1"))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
  it("详情仅返回设备序号；金额变化拒绝、结账冻结金额、撤销令牌和重复结账", async () => {
    const d = await data();
    const b = await finish(d.getStoreBill("bill-a1"));
    expect(b.orders[0].device_seq_in_bill).toBe(1);
    expect(JSON.stringify(b)).not.toMatch(/device_id|hash/);
    await expect(
      finish(d.markBillPaid(b.id, b.total_cents + 1)),
    ).rejects.toMatchObject({
      code: "BILL_TOTAL_CHANGED",
      details: { total_cents: b.total_cents },
      status: 409,
    });
    expect(
      (await finish(d.markBillPaid(b.id, b.total_cents))).tokens_revoked,
    ).toBe(2);
    await expect(finish(d.getTableBill("demo-a1"))).rejects.toMatchObject({
      code: "BILL_TOKEN_EXPIRED",
      details: { reason: "bill_paid" },
      status: 410,
    });
    await finish(d.saveStoreProfile({ service_charge_bp: 2000, sst_bp: 1000 }));
    expect((await finish(d.getStoreBill(b.id))).total_cents).toBe(
      b.total_cents,
    );
    await expect(
      finish(d.markBillPaid(b.id, b.total_cents)),
    ).rejects.toMatchObject({ code: "BILL_ALREADY_PAID" });
    await expect(finish(d.markBillPaid("missing", 0))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
describe("PR-D P8 桌号", () => {
  it("新增、去空格、大小写重名、改名校验和跨店权限", async () => {
    const d = await data();
    const id = await finish(d.createStoreTable("  C1  "));
    expect(
      (await finish(d.listStoreTables())).find((t) => t.id === id)?.label,
    ).toBe("C1");
    await expect(finish(d.createStoreTable("c1"))).rejects.toMatchObject({
      code: "TABLE_LABEL_TAKEN",
    });
    await expect(finish(d.renameStoreTable(id, "a1"))).rejects.toMatchObject({
      code: "TABLE_LABEL_TAKEN",
    });
    await expect(finish(d.createStoreTable(" "))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(
      finish(d.createStoreTable("长".repeat(21))),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await finish(d.renameStoreTable(id, "C2"));
    expect((await finish(d.getStoreTableQrLinks([id])))[0]).toMatchObject({
      table_id: id,
      label: "C2",
      url: expect.stringMatching(/^\/t\//),
    });
    await expect(finish(d.getStoreTableQrLinks(["b1"]))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(finish(d.renameStoreTable("b1", "no"))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
  it("重置使旧码失效，旧令牌410；新码无误报；软删保留历史", async () => {
    const d = await data();
    const [old] = await finish(d.getStoreTableQrLinks(["a1"]));
    expect(await finish(d.rotateStoreTableQr("a1"))).toMatchObject({
      qr_version: 2,
      tokens_revoked: 2,
    });
    const [next] = await finish(d.getStoreTableQrLinks(["a1"]));
    expect(next.url).not.toBe(old.url);
    await expect(
      finish(d.getTableMenu(old.url.slice(3))),
    ).rejects.toMatchObject({ code: "TABLE_INVALID" });
    expect(await finish(d.getTableBill(next.url.slice(3)))).toMatchObject({
      view: "table",
    });
    await expect(
      finish(d.getTableBill(old.url.slice(3))),
    ).rejects.toMatchObject({
      code: "BILL_TOKEN_EXPIRED",
      details: { reason: "qr_rotated" },
    });
    await expect(finish(d.softDeleteStoreTable("a1"))).rejects.toMatchObject({
      code: "TABLE_HAS_OPEN_BILL",
    });
    const b = await finish(d.getStoreBill("bill-a1"));
    await finish(d.markBillPaid(b.id, b.total_cents));
    await finish(d.softDeleteStoreTable("a1"));
    expect((await finish(d.listStoreTables())).some((t) => t.id === "a1")).toBe(
      false,
    );
    expect((await finish(d.getStoreBill(b.id))).orders).toHaveLength(6);
    await expect(finish(d.getStoreTableQrLinks(["a1"]))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      finish(d.getTableMenu(next.url.slice(3))),
    ).rejects.toMatchObject({ code: "TABLE_INVALID" });
  });
});
describe("PR-D P9 设置", () => {
  it("七列保存持久化，资料完整性只根据地址/营业时间，事件刷新黄条", async () => {
    const d = await data();
    const handler = vi.fn();
    window.addEventListener("ro-mock:change", handler);
    const saved = await finish(
      d.saveStoreProfile({
        name: "我的餐厅",
        logo_path: null,
        address: " 新地址 ",
        opening_hours: "10–20",
        is_accepting_orders: false,
        service_charge_bp: 0,
        sst_bp: 0,
      }),
    );
    expect(saved).toMatchObject({
      name: "我的餐厅",
      address: "新地址",
      is_profile_complete: true,
      is_accepting_orders: false,
    });
    expect((await finish(d.getSession()))?.store?.is_profile_complete).toBe(
      true,
    );
    expect(handler).toHaveBeenCalled();
    await finish(d.saveStoreProfile({ address: "  " }));
    expect((await finish(d.getStoreProfile())).is_profile_complete).toBe(false);
    await finish(d.saveStoreProfile({ address: "a", opening_hours: " " }));
    expect((await finish(d.getStoreProfile())).is_profile_complete).toBe(false);
    expect(
      (await finish(d.getTableMenu("demo-a1"))).store.is_accepting_orders,
    ).toBe(false);
  });
  it.each([
    { name: "" },
    { name: "x".repeat(51) },
    { address: "x".repeat(201) },
    { opening_hours: "x".repeat(201) },
    { service_charge_bp: 2001 },
    { sst_bp: 1001 },
    { sst_bp: -1 },
    { sst_bp: 1.5 },
    { logo_path: "https://invalid.test/logo.png" },
  ])("设置验证 %j，失败不污染已有资料", async (patch) => {
    const d = await data();
    const before = await finish(d.getStoreProfile());
    await expect(finish(d.saveStoreProfile(patch))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(await finish(d.getStoreProfile())).toEqual(before);
  });
});
describe("PR-D P10 记录和通用错误", () => {
  it("按马来西亚自然日筛订单；未付跨日实时；取消不计数；营业额按paid_at", async () => {
    const d = await data();
    const date = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const today = await finish(d.getStoreHistory(date));
    expect(today.orders).toHaveLength(6);
    expect(today.stats.orders).toEqual({ count: 4, cancelled_count: 2 });
    const empty = await finish(d.getStoreHistory("2000-01-01"));
    expect(empty.orders).toHaveLength(0);
    expect(empty.stats.open_bills).toEqual(today.stats.open_bills);
    await finish(d.saveStoreProfile({ service_charge_bp: 0, sst_bp: 0 }));
    expect(
      (await finish(d.getStoreHistory(date))).stats.open_bills.total_cents,
    ).toBe(today.stats.open_bills.subtotal_cents);
    const bill = await finish(d.getStoreBill("bill-a1"));
    await finish(d.markBillPaid(bill.id, bill.total_cents));
    const after = await finish(d.getStoreHistory(date));
    expect(after.stats.revenue_cents).toBe(bill.total_cents);
    expect(after.stats.open_bills.count).toBe(0);
    expect(after.stats.paid_bills.count).toBe(1);
    expect(
      (await finish(d.getStoreHistory("2000-01-01"))).stats.revenue_cents,
    ).toBe(0);
    for (const date of ["", "2026-02-30", "invalid"])
      await expect(finish(d.getStoreHistory(date))).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
  });
  it("UTC+8 午夜两侧、同账单跨日订单", async () => {
    const d = await data();
    await finish(d.getStoreProfile());
    const key = "ro-mock:state-v2",
      s = JSON.parse(localStorage.getItem(key)!);
    s.bills[0].orders = s.bills[0].orders.slice(0, 2);
    s.bills[0].orders[0].created_at = "2026-11-10T15:59:59Z";
    s.bills[0].orders[1].created_at = "2026-11-10T16:00:00Z";
    localStorage.setItem(key, JSON.stringify(s));
    expect((await finish(d.getStoreHistory("2026-11-10"))).orders).toHaveLength(
      1,
    );
    expect((await finish(d.getStoreHistory("2026-11-11"))).orders).toHaveLength(
      1,
    );
  });
  it("停用只读，写入被拒；网络失败和未登录", async () => {
    const d = await data();
    await d.runMockAction("suspend", "demo-a1");
    expect((await finish(d.listStoreTables())).length).toBeGreaterThan(0);
    await expect(
      finish(d.saveStoreProfile({ name: "改名" })),
    ).rejects.toMatchObject({ code: "STORE_SUSPENDED" });
    await expect(finish(d.createStoreTable("C"))).rejects.toMatchObject({
      code: "STORE_SUSPENDED",
    });
    await expect(finish(d.markBillPaid("bill-a1", 0))).rejects.toMatchObject({
      code: "STORE_SUSPENDED",
    });
    await d.configureMock({ fail_next: true });
    await expect(finish(d.listStoreBills("open"))).rejects.toMatchObject({
      code: "NETWORK",
    });
    await finish(d.signOut());
    await expect(finish(d.getStoreHistory("2026-11-11"))).rejects.toMatchObject(
      { code: "UNAUTHENTICATED" },
    );
  });
});

describe("PR-D 补充契约", () => {
  it("账单按桌号和付款日过滤，清空场景有空状态数据", async () => {
    const d = await data();
    const bill = await finish(d.getStoreBill("bill-a1"));
    await finish(d.markBillPaid(bill.id, bill.total_cents));
    const date = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    expect(
      (
        await finish(
          d.listStoreBills("paid", 1, { table_id: "a1", paid_date: date }),
        )
      ).total,
    ).toBe(1);
    expect(
      (await finish(d.listStoreBills("paid", 1, { table_id: "a2" }))).total,
    ).toBe(0);
    expect(
      (await finish(d.listStoreBills("paid", 1, { paid_date: "2000-01-01" })))
        .total,
    ).toBe(0);
    await expect(
      finish(d.listStoreBills("paid", 1, { paid_date: "2026-02-30" })),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await finish(d.storeMockActionD("empty"));
    expect((await finish(d.listStoreBills("open"))).total).toBe(0);
    expect((await finish(d.getStoreHistory(date))).orders).toHaveLength(0);
  });
  it("先结账再重置桌码，已撤销令牌保持 bill_paid 原因", async () => {
    const d = await data();
    await d.runMockAction("paid", "demo-a1");
    await d.runMockAction("rotate", "demo-a1");
    await expect(finish(d.getTableBill("demo-a1"))).rejects.toMatchObject({
      code: "BILL_TOKEN_EXPIRED",
      details: { reason: "bill_paid" },
    });
  });
  it("无店铺身份无权限；真实模式把订单记录交给后端实现", async () => {
    const d = await data();
    await d.authMockAction("identity", "nostore");
    await expect(finish(d.listStoreBills("open"))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", "supabase");
    vi.resetModules();
    const getStoreHistory = vi.fn(async (date: string) => ({
      orders: [],
      stats: {
        date,
        timezone: "Asia/Kuala_Lumpur" as const,
        currency: "MYR" as const,
        revenue_cents: 0,
        paid_bills: {
          count: 0,
          subtotal_cents: 0,
          service_charge_cents: 0,
          sst_cents: 0,
          rounding_cents: 0,
          total_cents: 0,
        },
        open_bills: { count: 0, subtotal_cents: 0, total_cents: 0 },
        orders: { count: 0, cancelled_count: 0 },
      },
    }));
    vi.doMock("../lib/data/supabase/history", () => ({ getStoreHistory }));
    const real = await import("../lib/data/d");
    await expect(real.getStoreHistory("2026-11-11")).resolves.toMatchObject({
      orders: [],
      stats: {
        date: "2026-11-11",
        timezone: "Asia/Kuala_Lumpur",
        currency: "MYR",
      },
    });
    expect(getStoreHistory).toHaveBeenCalledWith("2026-11-11");
    vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", "mock");
    vi.resetModules();
  });
});

it("旧控制面板结账也冻结金额并进入P10营业额", async () => {
  const d = await data();
  const before = await finish(d.getStoreBill("bill-a1"));
  await d.runMockAction("paid", "demo-a1");
  await finish(d.saveStoreProfile({ service_charge_bp: 0, sst_bp: 0 }));
  const date = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  expect((await finish(d.getStoreHistory(date))).stats.revenue_cents).toBe(
    before.total_cents,
  );
  expect((await finish(d.getStoreBill("bill-a1"))).total_cents).toBe(
    before.total_cents,
  );
});
