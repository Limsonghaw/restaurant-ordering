import { DataError, type LiveMockSettings, type LiveOrder } from "../types";
import { readState, saveState, delay } from "./state";
import { seedLiveOrders } from "./live-seed";
export const liveKey = "ro-mock:live-b";
interface Meta {
  status: string;
  updated_at: string;
  accepted_at: string | null;
  served_at: string | null;
  cancelled_at: string | null;
}
interface LiveState {
  settings: LiveMockSettings;
  meta: Record<string, Meta>;
  silent: Record<string, string>;
}
export function readLive(): LiveState {
  const raw = localStorage.getItem(liveKey);
  if (raw) return JSON.parse(raw) as LiveState;
  const state = readState();
  seedLiveOrders(state);
  saveState(state);
  const value: LiveState = {
    settings: {
      disconnected: false,
      hold: false,
      expired: false,
      fail_status: false,
      no_wake: false,
      sound_paused: false,
      threshold_ms: 120000,
    },
    meta: {},
    silent: {},
  };
  saveLive(value);
  return value;
}
export function saveLive(value: LiveState) {
  localStorage.setItem(liveKey, JSON.stringify(value));
}
export async function liveDelay() {
  await delay();
  if (readLive().settings.expired)
    throw new DataError(
      "UNAUTHENTICATED",
      "登录已过期，请重新登录，否则收不到新订单",
    );
}
export function allLiveOrders(storeId: string): LiveOrder[] {
  const live = readLive();
  const state = readState();
  const result: LiveOrder[] = [];
  for (const bill of state.bills) {
    const table = state.tables.find((t) => t.id === bill.table_id)!;
    if (table.store_id !== storeId) continue;
    for (const order of bill.orders) {
      let meta = live.meta[order.id];
      if (!meta || meta.status !== order.status) {
        const at = meta
          ? new Date(
              Math.max(Date.now(), Date.parse(meta.updated_at) + 1),
            ).toISOString()
          : order.created_at;
        meta = {
          status: order.status,
          updated_at: at,
          accepted_at:
            meta?.accepted_at ??
            (["accepted", "served"].includes(order.status) ? at : null),
          served_at: order.status === "served" ? at : null,
          cancelled_at: order.status === "cancelled" ? at : null,
        };
        live.meta[order.id] = meta;
      }
      result.push({
        id: order.id,
        store_id: table.store_id,
        table_id: table.id,
        bill_id: bill.id,
        seq_in_bill: order.seq_in_bill,
        device_seq_in_bill: order.device_seq_in_bill,
        status: order.status,
        subtotal_cents: order.subtotal_cents,
        item_count: order.item_count,
        created_at: order.created_at,
        updated_at: meta.updated_at,
        accepted_at: meta.accepted_at,
        served_at: meta.served_at,
        cancelled_at: meta.cancelled_at,
        cancel_reason: order.cancel_reason,
        cancel_note: order.cancel_note,
        order_items: order.lines,
        dining_tables: { label: table.label },
      });
    }
  }
  saveLive(live);
  return result;
}
