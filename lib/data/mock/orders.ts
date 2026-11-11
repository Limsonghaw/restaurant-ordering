import {
  DataError,
  type PlaceOrderBody,
  type PlaceOrderResult,
  type TableBill,
  type Order,
} from "../types";
import { quote } from "./menu";
import { calculateAmounts } from "./money";
import { delay, readState, saveState, tableFor } from "./state";
import type { InternalOrder } from "./seed";
function publicOrder(order: InternalOrder): Order {
  const {
    id,
    seq_in_bill,
    status,
    subtotal_cents,
    item_count,
    created_at,
    cancel_reason,
    lines,
  } = order;
  return {
    id,
    seq_in_bill,
    status,
    subtotal_cents,
    item_count,
    created_at,
    cancel_reason,
    lines,
  };
}
// C3；设备与令牌只在 mock 内部，页面不传入。
export async function placeOrder(
  code: string,
  body: PlaceOrderBody,
): Promise<PlaceOrderResult> {
  await delay();
  const state = readState();
  const { table, store } = tableFor(state, code);
  const payload = JSON.stringify(body.items);
  const key = `${table.id}:${state.device_id}:${body.client_request_id}`;
  const previous = state.requests[key];
  if (previous) {
    if (previous.payload !== payload)
      throw new DataError("IDEMPOTENCY_KEY_REUSED", "请重新确认下单", {}, 409);
    const bill = state.bills.find((b) => b.id === previous.bill_id)!;
    return {
      replayed: true,
      bill_token_issued: false,
      order: publicOrder(bill.orders.find((o) => o.id === previous.order_id)!),
      bill: { id: bill.id, status: bill.status },
    };
  }
  if (!/^[0-9a-f-]{36}$/i.test(body.client_request_id))
    throw new DataError("VALIDATION_FAILED", "请求编号无效");
  const next = state.settings.next_order;
  if (next) {
    state.settings.next_order = "";
    saveState(state);
    if (next === "PRICE_CHANGED" || next === "ITEM_UNAVAILABLE") {
      const item = state.items.find((i) => i.id === body.items[0]?.item_id);
      if (item) {
        if (next === "PRICE_CHANGED") item.price_cents += 100;
        else item.is_sold_out = true;
        saveState(state);
      }
    } else if (next === "CAPTCHA_REQUIRED" || next === "CAPTCHA_REQUIRED_IP") {
      state.settings.next_order = "captcha_pending";
      saveState(state);
      throw new DataError("CAPTCHA_REQUIRED", "请先完成人机验证", {
        scope: next.endsWith("_IP") ? "ip_db" : "device",
      });
    } else if (next === "captcha_pending") {
      if (!body.captcha_token) {
        state.settings.next_order = next;
        saveState(state);
        throw new DataError("CAPTCHA_REQUIRED", "请先完成人机验证");
      }
    } else if (next.startsWith("RATE_LIMITED"))
      throw new DataError(
        "RATE_LIMITED",
        "操作太频繁",
        {},
        429,
        next.endsWith("120") ? 120 : 30,
      );
    else if (next !== "NETWORK_AFTER")
      throw new DataError(
        next as "STORE_CLOSED",
        next === "STORE_CLOSED" ? "暂停接单" : "暂时无法下单",
      );
  }
  if (state.settings.captcha_fail && body.captcha_token) {
    state.settings.captcha_fail = false;
    state.settings.next_order = "captcha_pending";
    saveState(state);
    throw new DataError("CAPTCHA_FAILED", "人机验证没有通过，请再试一次");
  }
  if (store.require_captcha && !body.captcha_token)
    throw new DataError("CAPTCHA_REQUIRED", "请先完成人机验证");
  if (
    state.blocks.some(
      (b) =>
        b.store_id === store.id &&
        b.device_id === state.device_id &&
        Date.parse(b.expires_at) > Date.now(),
    )
  )
    throw new DataError(
      "DEVICE_BLOCKED",
      "暂时无法在这台手机下单，请联系店员",
      {},
      403,
    );
  const result = quote(state, code, body.items);
  if (!result.is_accepting_orders)
    throw new DataError("STORE_CLOSED", "暂停接单");
  if (result.limit_exceeded)
    throw new DataError(
      "ORDER_LIMIT_EXCEEDED",
      "单张订单最多 RM 3,000（或 200 件），请分开下单",
    );
  if (result.unavailable.length)
    throw new DataError("ITEM_UNAVAILABLE", "有菜品刚售完，请移除后再下单", {
      items: result.unavailable,
    });
  if (result.price_changes.length)
    throw new DataError("PRICE_CHANGED", "价格已更新，请确认后再下单", {
      items: result.price_changes,
    });
  if (!result.can_order)
    throw new DataError("VALIDATION_FAILED", "购物车是空的");
  let bill = state.bills.find(
    (b) => b.table_id === table.id && b.status === "open",
  );
  if (!bill) {
    bill = {
      id: crypto.randomUUID(),
      table_id: table.id,
      status: "open",
      opened_at: new Date().toISOString(),
      orders: [],
    };
    state.bills.push(bill);
  }
  if (bill.orders.length >= 60)
    throw new DataError(
      "ORDER_LIMIT_EXCEEDED",
      "一张账单最多 60 单，请联系店员",
    );
  const devices = [...new Set(bill.orders.map((o) => o.device_id))];
  let device_seq_in_bill = devices.indexOf(state.device_id) + 1;
  if (!device_seq_in_bill) device_seq_in_bill = devices.length + 1;
  const order: InternalOrder = {
    id: crypto.randomUUID(),
    seq_in_bill: bill.orders.length + 1,
    status: "new",
    subtotal_cents: result.subtotal_cents,
    item_count: result.item_count,
    created_at: new Date().toISOString(),
    cancel_reason: null,
    lines: result.lines.map(
      ({ item_name, unit_price_cents, quantity, line_total_cents, note }) => ({
        item_name,
        unit_price_cents,
        quantity,
        line_total_cents,
        note,
      }),
    ),
    device_id: state.device_id,
    device_seq_in_bill,
    cancel_note: null,
    auto_progress: state.settings.auto_progress,
  };
  bill.orders.push(order);
  state.tokens = state.tokens.filter(
    (t) => !(t.table_id === table.id && t.device_id === state.device_id),
  );
  state.tokens.push({
    table_id: table.id,
    bill_id: bill.id,
    device_id: state.device_id,
    token: crypto.randomUUID(),
    expires_at: Date.now() + 43200000,
  });
  state.requests[key] = { payload, order_id: order.id, bill_id: bill.id };
  saveState(state);
  if (next === "NETWORK_AFTER")
    throw new DataError("NETWORK", "下单没有成功，购物车已保留，请重试");
  return {
    replayed: false,
    bill_token_issued: true,
    order: publicOrder(order),
    bill: { id: bill.id, status: bill.status },
  };
}
// C4
export async function getTableBill(code: string): Promise<TableBill> {
  await delay();
  const state = readState();
  // 先处理被重置的旧码对应令牌，保证进度页先收到 410。
  const original = state.tables.find(
    (t) =>
      t.code === code ||
      t.original_code === code ||
      (code.startsWith(`${t.original_code}-r`) &&
        /^\d+$/.test(code.slice(t.original_code.length + 2)) &&
        Number(code.slice(t.original_code.length + 2)) < t.rotations),
  );
  const token =
    original &&
    state.tokens.find(
      (t) =>
        t.table_id === original.id &&
        t.device_id === state.device_id &&
        !(t.reason === "qr_rotated" && code === original.code),
    );
  if (token && (token.reason || token.expires_at <= Date.now())) {
    const reason = token.reason ?? "expired";
    state.tokens = state.tokens.filter((t) => t !== token);
    saveState(state);
    throw new DataError(
      "BILL_TOKEN_EXPIRED",
      "账单令牌已失效",
      { reason },
      410,
    );
  }
  const { table, store } = tableFor(state, code);
  const bill = token && state.bills.find((b) => b.id === token.bill_id);
  if (!bill || !token)
    return {
      view: "table",
      table_in_use: state.bills.some(
        (b) => b.table_id === table.id && b.status === "open",
      ),
      bill: null,
      orders: [],
      poll_after_ms: null,
    };
  for (const order of bill.orders)
    if (order.auto_progress && order.status !== "cancelled") {
      const elapsed = Date.now() - Date.parse(order.created_at);
      order.status =
        elapsed >= 40000 ? "served" : elapsed >= 20000 ? "accepted" : "new";
    }
  saveState(state);
  const own = bill.orders.filter((o) => o.device_id === state.device_id);
  const subtotal = own
    .filter((o) => o.status !== "cancelled")
    .reduce((n, o) => n + o.subtotal_cents, 0);
  return {
    view: "bill",
    scope: "own_orders",
    store: { name: store.name, is_accepting_orders: store.is_accepting_orders },
    table: { label: table.label },
    bill: {
      id: bill.id,
      status: bill.status,
      opened_at: bill.opened_at,
      paid_at: null,
      currency: "MYR",
      token_expires_at: new Date(token.expires_at).toISOString(),
      amounts_basis: "own_orders",
      ...calculateAmounts(subtotal, store.service_charge_bp, store.sst_bp),
      is_estimate: true,
    },
    orders: own.map(publicOrder).sort((a, b) => b.seq_in_bill - a.seq_in_bill),
    poll_after_ms: 10000,
  };
}
