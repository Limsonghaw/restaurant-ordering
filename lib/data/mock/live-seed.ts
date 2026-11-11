import type { State, InternalOrder } from "./seed";
import { malaysiaDay } from "../live-rules";
// 保留 PR-A 所有 A1 订单；仅补足 3 新 / 2 接 / 3 今日已上菜。
export function seedLiveOrders(state: State) {
  const { start } = malaysiaDay();
  for (let i = 0; i < 4; i++) {
    const created_at = new Date(
      Math.max(start, Date.now() - (25 - i) * 60000),
    ).toISOString();
    const lines = state.items
      .filter((x) => x.store_id === "store-0" && !x.hidden && !x.deleted)
      .slice(0, i === 0 ? 7 : 2)
      .map((item, n) => ({
        item_name: item.name,
        unit_price_cents: item.price_cents,
        quantity: 1,
        line_total_cents: item.price_cents,
        note:
          n === 0
            ? "不要葱、少盐，酱汁分开装。孩子对花生过敏，请特别留意，谢谢。"
            : "",
      }));
    const order: InternalOrder = {
      id: `live-seed-${i}`,
      seq_in_bill: 1,
      status: i === 0 ? "new" : i === 1 ? "accepted" : "served",
      subtotal_cents: lines.reduce(
        (sum, line) => sum + line.line_total_cents,
        0,
      ),
      item_count: lines.length,
      created_at,
      cancel_reason: null,
      lines,
      device_id: "mock-live-device",
      device_seq_in_bill: 1,
      cancel_note: null,
      auto_progress: false,
    };
    state.bills.push({
      id: `live-bill-${i}`,
      table_id: `a${i + 2}`,
      status: "open",
      opened_at: created_at,
      orders: [order],
    });
  }
}
