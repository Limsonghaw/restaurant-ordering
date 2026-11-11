import type { StoreBillRow } from "../types";
import type { State, InternalBill } from "./seed";
import { calculateAmounts } from "./money";
/** Legacy A/B panel settlement uses the same frozen P6/P10 snapshot as R2. No auth here: mock controls only. */
export function settleFromControlD(state: State, bill: InternalBill) {
  if (bill.status === "paid") return;
  const table = state.tables.find((t) => t.id === bill.table_id)!;
  const store = state.stores.find((s) => s.id === table.store_id)!;
  const subtotal = bill.orders
    .filter((o) => o.status !== "cancelled")
    .reduce((n, o) => n + o.subtotal_cents, 0);
  const snapshot: StoreBillRow = {
    id: bill.id,
    table_id: table.id,
    table_label: table.label,
    status: "paid",
    opened_at: bill.opened_at,
    paid_at: new Date().toISOString(),
    service_charge_bp: store.service_charge_bp,
    sst_bp: store.sst_bp,
    ...calculateAmounts(subtotal, store.service_charge_bp, store.sst_bp),
  };
  const key = "ro-mock:store-d";
  const meta = JSON.parse(
    localStorage.getItem(key) ?? '{"deleted":{},"paid":{}}',
  );
  meta.paid[bill.id] = snapshot;
  localStorage.setItem(key, JSON.stringify(meta));
  bill.status = "paid";
  state.tokens
    .filter((t) => t.bill_id === bill.id)
    .forEach((t) => {
      t.reason = "bill_paid";
    });
}
