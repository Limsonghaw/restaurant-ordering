import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DataError, type ErrorCode } from "../lib/data/types";
import { errorMessage } from "../lib/format";
import {
  percentToBp,
  bpToPercent,
  needsClosingConfirmation,
  pauseMessage,
  disableTableMessage,
  resetTableMessage,
  resetTableNotice,
  unservedCount,
  unservedMessage,
  paymentFailure,
  malaysiaToday,
  adjacentDay,
  validHistoryDate,
  tableQrUrl,
  printGroups,
} from "../lib/ui/store-d-helpers";

// QR rendering does not use Next Image; isolate its browser-only deployment bootstrap.
vi.mock("next/image", () => ({ default: () => null }));

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", "mock");
  vi.stubGlobal("window", new EventTarget());
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
    removeItem: (k: string) => values.delete(k),
  });
  await (await import("../lib/data")).authMockAction("identity", "owner");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
async function finish<T>(p: Promise<T>) {
  const guarded = p.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await vi.runAllTimersAsync();
  const result = await guarded;
  if ("error" in result) throw result.error;
  return result.value;
}
it.each([
  ["0", 20, 0],
  ["20", 20, 2000],
  ["20.01", 20, undefined],
  ["6.15", 20, 615],
  ["6.150", 20, undefined],
  ["10", 10, 1000],
  ["10.01", 10, undefined],
  ["-1", 20, undefined],
  ["", 20, undefined],
  ["1e1", 20, undefined],
  ["0.01", 20, 1],
  ["19.99", 20, 1999],
  ["0.001", 20, undefined],
])("百分比 %s 上限 %i 精确转基点", (text, max, bp) => {
  expect(percentToBp(String(text), Number(max))).toBe(bp);
  if (bp !== undefined)
    expect(percentToBp(bpToPercent(Number(bp)), Number(max))).toBe(bp);
});
it("所有合法基点显示后精确往返", () => {
  for (let n = 0; n <= 2000; n++)
    expect(percentToBp(bpToPercent(n), 20)).toBe(n);
});
it("仅关闭营业需要确认，取消不修改状态", () => {
  expect(needsClosingConfirmation(false)).toBe(true);
  expect(needsClosingConfirmation(true)).toBe(false);
  expect(pauseMessage).toBe("关闭后顾客不能下单，确定暂停接单？");
});
it("桌子停用后菜单/报价返回 TABLE_INVALID，恢复启用继续使用原码", async () => {
  const d = await import("../lib/data");
  const [link] = await finish(d.getStoreTableQrLinks(["a1"]));
  await finish(d.setStoreTableActive("a1", false));
  expect(
    (await finish(d.listStoreTables())).find((t) => t.id === "a1")?.is_active,
  ).toBe(false);
  for (const request of [
    () => d.getTableMenu(link.url.slice(3)),
    () => d.quoteCart(link.url.slice(3), []),
  ]) {
    const e = await finish<unknown>(request()).catch((e) => e);
    expect(e).toMatchObject({ code: "TABLE_INVALID", status: 404 });
    expect(errorMessage(e)).toBe("这个二维码已失效，请联系店员");
  }
  await finish(d.setStoreTableActive("a1", true));
  expect((await finish(d.getTableMenu(link.url.slice(3)))).table.label).toBe(
    "A1",
  );
  expect(disableTableMessage).toBe(
    "停用后扫这张桌子的二维码会显示「二维码已失效」，确定停用？",
  );
  await expect(
    finish(d.setStoreTableActive("b1", false)),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await d.runMockAction("suspend", "demo-a1");
  await expect(
    finish(d.setStoreTableActive("a1", false)),
  ).rejects.toMatchObject({ code: "STORE_SUSPENDED" });
});
it("重置文案和新码链接", async () => {
  const d = await import("../lib/data");
  const [before] = await finish(d.getStoreTableQrLinks(["a1"]));
  await finish(d.rotateStoreTableQr("a1"));
  const [after] = await finish(d.getStoreTableQrLinks(["a1"]));
  expect(after.url).toBe(`${before.url}-r1`);
  expect(resetTableNotice("A3")).toBe("已重置，请重新下载并打印 A3 桌的二维码");
  expect(resetTableMessage("A3")).toBe(
    "重置后，A3 桌的旧二维码立即失效，正在用餐的顾客需要重新扫码。重置后请重新下载并打印这张桌子的二维码。确定重置？",
  );
});
it("重复付款要求关闭和刷新；金额变化保留确认并使用新金额再次付款", async () => {
  const d = await import("../lib/data");
  const b = await finish(d.getStoreBill("bill-a1"));
  await finish(d.saveStoreProfile({ service_charge_bp: 2000 }));
  const e = await finish(d.markBillPaid(b.id, b.total_cents)).catch((e) => e);
  const failure = paymentFailure(e);
  expect(failure.close).toBe(false);
  expect(failure.message).toBe(
    `这桌金额已变化，新的总计是 RM ${(e.details.total_cents / 100).toFixed(2)}，请再确认`,
  );
  const paid = await finish(d.markBillPaid(b.id, failure.total!));
  expect(paid.total_cents).toBe(failure.total);
  const already = await finish(d.markBillPaid(b.id, failure.total!)).catch(
    (e) => e,
  );
  expect(paymentFailure(already)).toEqual({
    close: true,
    message: "这桌已经结账",
  });
  expect((await finish(d.listStoreBills("open"))).bills).toHaveLength(0);
  expect(paymentFailure(new Error("offline")).message).toBe(
    "标记没有成功，请重试",
  );
  expect(
    paymentFailure(
      new DataError("BILL_TOTAL_CHANGED" as ErrorCode, "x", {
        total_cents: NaN,
      }),
    ).total,
  ).toBeUndefined();
});
it("N 只计算新单和已接单，列表和详情相同；0不显示确认提示", async () => {
  expect(
    unservedCount([
      { status: "new" },
      { status: "accepted" },
      { status: "served" },
      { status: "cancelled" },
    ]),
  ).toBe(2);
  expect(unservedMessage(0)).toBe("");
  expect(unservedMessage(2)).toBe("这桌还有 2 单未上菜，确定要结账吗？");
  const d = await import("../lib/data");
  const detail = await finish(d.getStoreBill("bill-a1"));
  const row = (await finish(d.listStoreBills("open"))).bills[0];
  expect(row.unserved_count).toBe(unservedCount(detail.orders));
  expect(row.order_count).toBe(detail.orders.length);
});
it("P10 营业额分项来自已付款快照，历史日不含今日营业额", async () => {
  const d = await import("../lib/data");
  const b = await finish(d.getStoreBill("bill-a1"));
  await finish(d.markBillPaid(b.id, b.total_cents));
  const stats = (await finish(d.getStoreHistory(malaysiaToday()))).stats;
  expect(stats.paid_bills).toMatchObject({
    subtotal_cents: b.subtotal_cents,
    service_charge_cents: b.service_charge_cents,
    sst_cents: b.sst_cents,
  });
  expect(stats.revenue_cents).toBe(stats.paid_bills.total_cents);
  const zero = (await finish(d.getStoreHistory("2000-01-01"))).stats.paid_bills;
  expect([
    zero.subtotal_cents,
    zero.service_charge_cents,
    zero.sst_cents,
  ]).toEqual([0, 0, 0]);
});
it("UTC+8今天/日期边界/前后一天，未来日期拒绝", () => {
  expect(malaysiaToday(Date.parse("2026-11-10T15:59:59Z"))).toBe("2026-11-10");
  expect(malaysiaToday(Date.parse("2026-11-10T16:00:00Z"))).toBe("2026-11-11");
  expect(adjacentDay("2024-03-01", -1)).toBe("2024-02-29");
  expect(adjacentDay("2026-12-31", 1)).toBe("2027-01-01");
  expect(validHistoryDate("2026-11-12", "2026-11-11")).toBe(false);
  expect(validHistoryDate("2026-11-11", "2026-11-11")).toBe(true);
  expect(validHistoryDate("2026-02-30", "2026-11-11")).toBe(false);
});
it("二维码完整 URL 使用配置站点或固定开发占位，保留已有桌码编码", () => {
  expect(tableQrUrl("/t/demo-a1-r1", "https://site.example.invalid")).toBe(
    "https://site.example.invalid/t/demo-a1-r1",
  );
  expect(tableQrUrl("/t/mock-%E6%A1%8C", undefined)).toBe(
    "http://localhost:3000/t/mock-%E6%A1%8C",
  );
  expect(tableQrUrl("/t/a", "")).toBe("http://localhost:3000/t/a");
});
it.each([0, 1, 3, 4, 5, 8, 9, 12])(
  "%i张二维码每4张换页，最后无多余换页",
  (count) => {
    const cards = Array.from({ length: count }, (_, i) => i);
    const groups = printGroups(cards);
    expect(groups.flatMap((g) => g.cards)).toEqual(cards);
    expect(groups).toHaveLength(Math.ceil(count / 4));
    groups.forEach((g, i) => {
      expect(g.cards.length).toBeLessThanOrEqual(4);
      expect(g.breakAfter).toBe(i < groups.length - 1);
    });
  },
);

it("6.15% 保存为615基点，重新读取仍显示6.15", async () => {
  const d = await import("../lib/data");
  await finish(
    d.saveStoreProfile({ service_charge_bp: percentToBp("6.15", 20) }),
  );
  expect(
    bpToPercent((await finish(d.getStoreProfile())).service_charge_bp),
  ).toBe("6.15");
});
it("账单列表按桌号自然排序", async () => {
  const d = await import("../lib/data");
  await finish(d.getStoreProfile());
  const key = "ro-mock:state-v2";
  const state = JSON.parse(localStorage.getItem(key)!);
  state.tables.push({
    ...state.tables.find((t: { id: string }) => t.id === "a1"),
    id: "a10",
    label: "A10",
  });
  state.bills.unshift({
    ...state.bills.find((b: { id: string }) => b.id === "bill-a1"),
    id: "bill-a10",
    table_id: "a10",
  });
  localStorage.setItem(key, JSON.stringify(state));
  expect(
    (await finish(d.listStoreBills("open"))).bills.map((b) => b.table_label),
  ).toEqual(["A1", "A10"]);
});
it("二维码预览实际渲染SVG、店名和扫码点餐；打印CSS使用独立区域和显式分页", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { readFileSync } = await import("node:fs");
  Object.assign(window, { location: { origin: "http://localhost:3000" } });
  const { QrCardD } = await import("../lib/ui/qr-d");
  const html = renderToStaticMarkup(
    createElement(QrCardD, {
      link: { table_id: "a1", label: "A1", url: "/t/demo-a1" },
      storeName: "测试茶餐室",
    }),
  );
  expect(html).toContain("<svg");
  expect(html).toContain("测试茶餐室");
  expect(html).toContain("扫码点餐");
  expect(html).not.toContain("不可扫码");
  const css = readFileSync("app/globals.css", "utf8");
  expect(css).toContain("body:has(> .d-print) > :not(.d-print)");
  expect(css).toContain("break-after: page");
  const qr = readFileSync("lib/ui/qr-d.tsx", "utf8");
  expect(qr).toContain("createPortal(");
  expect(qr).toContain("group.breakAfter");
  expect(qr).toContain('level="M"');
  expect(qr).toContain("marginSize={4}");
});
