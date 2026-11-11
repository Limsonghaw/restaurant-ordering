import { describe, expect, it } from "vitest";
import {
  formatMoney,
  formatTime,
  countdownRemaining,
  errorMessage,
  goneMessages,
} from "../lib/format";
import { addCartLine } from "../lib/cart";
import { DataError } from "../lib/data/types";
import { routes } from "../lib/routes";
describe("公共纯函数", () => {
  it("金额两位小数无千位分隔", () => {
    expect(formatMoney(1250)).toBe("RM 12.50");
    expect(formatMoney(300000)).toBe("RM 3000.00");
    expect(formatMoney(0)).toBe("RM 0.00");
  });
  it("马来西亚时区跨日", () => {
    expect(formatTime("2026-11-04T17:01:00Z")).toContain("11/05");
    expect(formatTime("2026-11-04T17:01:00Z")).toContain("01:01");
  });
  it("倒计时不为负并向上取整", () => {
    expect(countdownRemaining(2001, 1000)).toBe(2);
    expect(countdownRemaining(0, 1000)).toBe(0);
  });
  it("错误码固定文案与未知错误使用通用文案", () => {
    expect(errorMessage(new DataError("TABLE_INVALID", "x"))).toBe(
      "这个二维码已失效，请联系店员",
    );
    expect(errorMessage(new DataError("NOT_IMPLEMENTED", "未实现"))).toBe(
      "操作没有成功，请稍后再试",
    );
    expect(
      errorMessage(new DataError("PAYLOAD_TOO_LARGE" as never, "private")),
    ).toBe("订单内容过多，请减少菜品后再下单");
    expect(Object.keys(goneMessages)).toEqual([
      "bill_paid",
      "qr_rotated",
      "expired",
    ]);
  });
  it("同菜同备注合并，不同备注分行；保护数量行数件数上限", () => {
    const line = { item_id: "1", quantity: 1, note: "", unit_price_cents: 390 };
    expect(addCartLine([line], line)?.[0].quantity).toBe(2);
    expect(addCartLine([line], { ...line, note: "少冰" })).toHaveLength(2);
    expect(addCartLine([{ ...line, quantity: 99 }], line)).toBeNull();
    expect(
      addCartLine(
        Array.from({ length: 30 }, (_, i) => ({ ...line, item_id: String(i) })),
        { ...line, item_id: "new" },
      ),
    ).toBeNull();
    expect(
      addCartLine(
        [
          { ...line, quantity: 99 },
          { ...line, item_id: "2", quantity: 99 },
          { ...line, item_id: "3", quantity: 2 },
        ],
        { ...line, item_id: "4" },
      ),
    ).toBeNull();
  });
  it("桌码按路径段编码", () => {
    expect(routes.menu("a/b?")).toBe("/t/a%2Fb%3F");
  });
});
