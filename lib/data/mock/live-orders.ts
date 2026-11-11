import {
  DataError,
  type LiveOrder,
  type OrderStatusChange,
  type LiveStoreStatus,
  type StoreOrderCallbacks,
} from "../types";
import { malaysiaDay, validateOrderChange } from "../live-rules";
import { readState, saveState } from "./state";
import { allLiveOrders, liveDelay, readLive, saveLive } from "./live-state";
// M9
export async function listLiveOrders(): Promise<LiveOrder[]> {
  await liveDelay();
  return allLiveOrders()
    .filter((o) => o.status === "new" || o.status === "accepted")
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}
export async function listServedToday(): Promise<LiveOrder[]> {
  await liveDelay();
  const { start, end } = malaysiaDay();
  return allLiveOrders()
    .filter(
      (o) =>
        o.status === "served" &&
        o.served_at &&
        Date.parse(o.served_at) >= start &&
        Date.parse(o.served_at) < end,
    )
    .sort((a, b) => b.served_at!.localeCompare(a.served_at!));
}
// M9 补拉，包括取消单。
export async function fetchOrdersUpdatedSince(
  since: string,
): Promise<LiveOrder[]> {
  await liveDelay();
  return allLiveOrders().filter((o) => o.updated_at > since);
}
// R1 update_order_status: p_order_id / p_to / p_expected / p_cancel_reason / p_cancel_note
export async function updateOrderStatus(
  order_id: string,
  change: OrderStatusChange,
): Promise<LiveOrder> {
  await liveDelay();
  const live = readLive();
  if (live.settings.fail_status) {
    live.settings.fail_status = false;
    saveLive(live);
    throw new DataError("NETWORK", "操作没有成功，请重试");
  }
  const current = allLiveOrders().find((o) => o.id === order_id);
  const state = readState();
  if (state.stores[0].status === "suspended")
    throw new DataError("STORE_SUSPENDED", "店铺已被平台停用，请联系平台");
  if (!current) throw new DataError("NOT_FOUND", "找不到订单");
  const bill = state.bills.find((b) => b.id === current.bill_id)!;
  validateOrderChange(current, change, bill.status === "paid");
  const order = bill.orders.find((o) => o.id === order_id)!;
  order.status = change.to;
  if (change.to === "cancelled") {
    order.cancel_reason = change.cancel_reason!;
    order.cancel_note =
      change.cancel_reason === "other" ? change.cancel_note || null : null;
  }
  saveState(state);
  return allLiveOrders().find((o) => o.id === order_id)!;
}
// M2
export async function getStoreStatus(): Promise<LiveStoreStatus> {
  await liveDelay();
  const { name, status, is_accepting_orders } = readState().stores[0];
  return { name, status, is_accepting_orders };
}
// M3
export async function setAcceptingOrders(
  value: boolean,
): Promise<LiveStoreStatus> {
  await liveDelay();
  const state = readState();
  const store = state.stores[0];
  if (store.status === "suspended")
    throw new DataError("STORE_SUSPENDED", "店铺已被平台停用，请联系平台");
  store.is_accepting_orders = value;
  store.updated_at = new Date().toISOString();
  saveState(state);
  return { name: store.name, status: store.status, is_accepting_orders: value };
}
// M10，模拟私有频道 store:{id}；轮询本地存储也支持顾客分页下单。
export function subscribeStoreOrders(
  store_id: string,
  callbacks: StoreOrderCallbacks,
): () => void {
  const live = readLive();
  if (!live.settings.hold) {
    live.settings.disconnected = false;
    saveLive(live);
  }
  const seen = new Map(allLiveOrders().map((o) => [o.id, o.updated_at]));
  let connection = "";
  const tick = () => {
    const live = readLive();
    const status =
      live.settings.disconnected || !navigator.onLine
        ? "disconnected"
        : "connected";
    if (status !== connection) {
      connection = status;
      callbacks.onConnectionChange(status);
    }
    if (status !== "connected" || live.settings.expired) return;
    for (const order of allLiveOrders().filter(
      (o) => o.store_id === store_id,
    )) {
      const previous = seen.get(order.id);
      if (
        previous !== order.updated_at &&
        live.silent[order.id] !== order.updated_at
      ) {
        if (previous) callbacks.onUpdate(order);
        else callbacks.onInsert(order);
      }
      seen.set(order.id, order.updated_at);
    }
  };
  const timer = setInterval(tick, 500);
  tick();
  return () => clearInterval(timer);
}
