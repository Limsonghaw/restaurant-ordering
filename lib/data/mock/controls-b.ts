import {
  DataError,
  type LiveMockAction,
  type LiveMockSettings,
} from "../types";
import { allLiveOrders, readLive, saveLive } from "./live-state";
import { readState, saveState } from "./state";
import { storeContext } from "./menu-c";
export async function getLiveMockSettings(): Promise<LiveMockSettings> {
  return readLive().settings;
}
export async function configureLiveMock(patch: Partial<LiveMockSettings>) {
  const live = readLive();
  Object.assign(live.settings, patch);
  saveLive(live);
  window.dispatchEvent(new Event("ro-mock:live"));
}
export async function runLiveMockAction(action: LiveMockAction) {
  readLive();
  const storeId = await storeContext().catch((error: unknown) => {
    if (
      error instanceof DataError &&
      ["UNAUTHENTICATED", "FORBIDDEN"].includes(error.code)
    )
      return readState().stores[0].id;
    throw error;
  });
  if (["disconnect", "reconnect"].includes(action)) {
    await configureLiveMock(
      action === "disconnect"
        ? { disconnected: true }
        : { disconnected: false, hold: false },
    );
    return;
  }
  if (["new", "three", "missed"].includes(action)) {
    const count = action === "three" ? 3 : action === "missed" ? 2 : 1;
    for (let n = 0; n < count; n++) {
      const state = readState();
      const tables = state.tables.filter(
        (t) => t.store_id === storeId && t.active,
      );
      const table = tables[Math.floor(Math.random() * tables.length)];
      if (!table) continue;
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
      const items = state.items.filter(
        (i) =>
          i.store_id === storeId && !i.hidden && !i.deleted && !i.is_sold_out,
      );
      if (!items.length) continue;
      const start = Math.floor(Math.random() * Math.max(1, items.length - 2));
      const lines = items
        .slice(start, start + 1 + Math.floor(Math.random() * 3))
        .map((i) => ({
          item_name: i.name,
          unit_price_cents: i.price_cents,
          quantity: 1,
          line_total_cents: i.price_cents,
          note: Math.random() > 0.5 ? "少冰，不要葱，谢谢" : "",
        }));
      bill.orders.push({
        id: crypto.randomUUID(),
        seq_in_bill: bill.orders.length + 1,
        status: "new",
        subtotal_cents: lines.reduce((sum, l) => sum + l.line_total_cents, 0),
        item_count: lines.length,
        created_at: new Date().toISOString(),
        cancel_reason: null,
        lines,
        device_id: "mock-new-device",
        device_seq_in_bill: 2,
        cancel_note: null,
        auto_progress: false,
      });
      saveState(state);
    }
  } else {
    const orders = allLiveOrders(storeId).sort((a, b) =>
      a.created_at.localeCompare(b.created_at),
    );
    const order = orders.find(
      (o) => o.status === (action === "paid" ? "accepted" : "new"),
    );
    if (!order) return;
    const state = readState();
    const bill = state.bills.find((b) => b.id === order.bill_id)!;
    if (action === "paid") bill.status = "paid";
    else bill.orders.find((o) => o.id === order.id)!.status = "accepted";
    saveState(state);
    const updated = allLiveOrders(storeId).find((o) => o.id === order.id)!;
    if (action === "other_silent") {
      const live = readLive();
      live.silent[order.id] = updated.updated_at;
      saveLive(live);
    }
  }
  window.dispatchEvent(new Event("ro-mock:live"));
}
