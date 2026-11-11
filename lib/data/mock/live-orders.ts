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
import { storeContext } from "./menu-c";
// M9
export async function listLiveOrders(): Promise<LiveOrder[]> {
  await liveDelay();
  const storeId = await storeContext();
  return allLiveOrders(storeId)
    .filter((o) => o.status === "new" || o.status === "accepted")
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}
export async function listServedToday(): Promise<LiveOrder[]> {
  await liveDelay();
  const storeId = await storeContext();
  const { start, end } = malaysiaDay();
  return allLiveOrders(storeId)
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
  const storeId = await storeContext();
  return allLiveOrders(storeId).filter((o) => o.updated_at > since);
}
// R1 update_order_status: p_order_id / p_to / p_expected / p_cancel_reason / p_cancel_note
export async function updateOrderStatus(
  order_id: string,
  change: OrderStatusChange,
): Promise<LiveOrder> {
  await liveDelay();
  const storeId = await storeContext(true);
  const live = readLive();
  if (live.settings.fail_status) {
    live.settings.fail_status = false;
    saveLive(live);
    throw new DataError("NETWORK", "操作没有成功，请重试");
  }
  const current = allLiveOrders(storeId).find((o) => o.id === order_id);
  const state = readState();
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
  return allLiveOrders(storeId).find((o) => o.id === order_id)!;
}
// M2
export async function getStoreStatus(): Promise<LiveStoreStatus> {
  await liveDelay();
  const storeId = await storeContext();
  const { name, status, is_accepting_orders } = readState().stores.find(
    (s) => s.id === storeId,
  )!;
  return { name, status, is_accepting_orders };
}
// M3
export async function setAcceptingOrders(
  value: boolean,
): Promise<LiveStoreStatus> {
  await liveDelay();
  const storeId = await storeContext(true);
  const state = readState();
  const store = state.stores.find((s) => s.id === storeId)!;
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
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  void (async () => {
    const storeId = await storeContext();
    if (stopped) return;
    if (storeId !== store_id) throw new DataError("FORBIDDEN", "没有权限");
    const live = readLive();
    if (!live.settings.hold) {
      live.settings.disconnected = false;
      saveLive(live);
    }
    const seen = new Map(
      allLiveOrders(storeId).map((o) => [o.id, o.updated_at]),
    );
    let connection = "";
    const tick = async () => {
      try {
        const currentId = await storeContext();
        if (stopped) return;
        if (currentId !== storeId) throw new DataError("FORBIDDEN", "没有权限");
        const live = readLive();
        const status =
          live.settings.disconnected ||
          live.settings.expired ||
          !navigator.onLine
            ? "disconnected"
            : "connected";
        if (status !== connection) {
          connection = status;
          callbacks.onConnectionChange(status);
        }
        if (stopped || status !== "connected") return;
        for (const order of allLiveOrders(storeId)) {
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
      } catch {
        clearInterval(timer);
        if (!stopped) callbacks.onConnectionChange("disconnected");
      }
    };
    timer = setInterval(() => void tick(), 500);
    await tick();
  })().catch(() => {
    if (!stopped) callbacks.onConnectionChange("disconnected");
  });
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
