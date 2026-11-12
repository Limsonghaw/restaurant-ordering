import { describe, expect, it, vi } from "vitest";
import {
  emptyCartQuote,
  requestCartQuote,
  shouldRequestQuote,
} from "../lib/customer-quote";
import { quoteErrorMessage, errorMessage } from "../lib/format";
import { DataError, type CartItem } from "../lib/data/types";

const line: CartItem = {
  item_id: "11111111-1111-1111-1111-111111111111",
  quantity: 1,
  note: "",
  unit_price_cents: 100,
};

describe("empty-cart quote is local", () => {
  it("does not call the API when the cart is empty and returns a zero quote", async () => {
    const fetchQuote = vi.fn();
    const quote = await requestCartQuote("table-code", [], fetchQuote);
    expect(fetchQuote).not.toHaveBeenCalled();
    expect(quote).toEqual(emptyCartQuote());
    expect(quote.item_count).toBe(0);
    expect(quote.subtotal_cents).toBe(0);
    expect(quote.estimated_total_cents).toBe(0);
    expect(quote.lines).toEqual([]);
    expect(quote.can_order).toBe(false);
  });

  it("forwards a non-empty cart to the API", async () => {
    const remote = { ...emptyCartQuote(), item_count: 1, subtotal_cents: 100 };
    const fetchQuote = vi.fn().mockResolvedValue(remote);
    await expect(
      requestCartQuote("table-code", [line], fetchQuote),
    ).resolves.toBe(remote);
    expect(fetchQuote).toHaveBeenCalledOnce();
    expect(fetchQuote).toHaveBeenCalledWith("table-code", [line]);
  });

  it("waits until cart storage is ready, the menu (did cookie) has loaded, and the cart has items", () => {
    expect(shouldRequestQuote(false, true, [line])).toBe(false);
    expect(shouldRequestQuote(true, false, [line])).toBe(false);
    expect(shouldRequestQuote(true, true, [])).toBe(false);
    expect(shouldRequestQuote(true, true, [line])).toBe(true);
  });
});

describe("quote error copy", () => {
  it("keeps specific messages and uses a calmer fallback than the generic red copy", () => {
    expect(quoteErrorMessage(new DataError("ITEM_UNAVAILABLE", "x"))).toBe(
      "有菜品刚售完，请移除后再下单",
    );
    expect(quoteErrorMessage(new DataError("DEVICE_BLOCKED", "x"))).toBe(
      "暂时无法在这台手机下单，请联系店员",
    );
    expect(
      quoteErrorMessage(
        new DataError("VALIDATION_FAILED", "输入内容不符合要求"),
      ),
    ).toBe("暂时无法计算金额，请重试");
    expect(
      quoteErrorMessage(new DataError("NETWORK", "网络出错，请重试")),
    ).toBe("网络出错，请检查网络后重试");
    expect(
      errorMessage(new DataError("VALIDATION_FAILED", "输入内容不符合要求")),
    ).toBe("操作没有成功，请稍后再试");
    expect(quoteErrorMessage(new DataError("VALIDATION_FAILED", "x"))).not.toBe(
      errorMessage(new DataError("VALIDATION_FAILED", "x")),
    );
  });
});
