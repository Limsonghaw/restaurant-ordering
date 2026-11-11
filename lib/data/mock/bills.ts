import {
  DataError,
  type BillFilters,
  type BillListRow,
  type BillPage,
  type BillDetail,
  type CheckoutResult,
  type ErrorCode,
} from "../types";
import { storeContext } from "./menu-c";
import { readState, saveState } from "./state";
import { calculateAmounts } from "./money";
import { allLiveOrders } from "./live-state";
import { malaysiaDay } from "../live-rules";
type BillWithSnapshot = ReturnType<typeof readState>["bills"][number] & {
  merchant_snapshot?: BillListRow;
};
async function rows(): Promise<BillListRow[]> {
  const store = await storeContext(),
    state = readState(),
    s = state.stores.find((s) => s.id === store)!;
  return state.bills
    .filter((b) =>
      state.tables.some((t) => t.id === b.table_id && t.store_id === store),
    )
    .map(
      (b) =>
        (b as BillWithSnapshot).merchant_snapshot ?? {
          ...calculateAmounts(
            b.orders
              .filter((o) => o.status !== "cancelled")
              .reduce((n, o) => n + o.subtotal_cents, 0),
            s.service_charge_bp,
            s.sst_bp,
          ),
          id: b.id,
          store_id: store,
          table_id: b.table_id,
          table_label: state.tables.find((t) => t.id === b.table_id)!.label,
          status: b.status,
          opened_at: b.opened_at,
          paid_at: null,
          updated_at: b.opened_at,
          service_charge_bp: s.service_charge_bp,
          sst_bp: s.sst_bp,
          is_estimate: b.status === "open",
          order_count: b.orders.length,
          unserved_count: b.orders.filter((o) =>
            ["new", "accepted"].includes(o.status),
          ).length,
          currency: "MYR",
        },
    );
}
export async function listBills(filters: BillFilters = {}): Promise<BillPage> {
  const page = filters.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1)
    throw new DataError("VALIDATION_FAILED", "页码无效");
  const from = filters.paid_from
    ? malaysiaDay(Date.parse(filters.paid_from + "T00:00:00+08:00")).start
    : -Infinity;
  const to = filters.paid_to
    ? malaysiaDay(Date.parse(filters.paid_to + "T00:00:00+08:00")).end
    : Infinity;
  const all = (await rows())
    .filter(
      (b) =>
        (!filters.status || b.status === filters.status) &&
        (!filters.table_id || b.table_id === filters.table_id) &&
        ((!filters.paid_from && !filters.paid_to) ||
          (b.paid_at &&
            Date.parse(b.paid_at) >= from &&
            Date.parse(b.paid_at) < to)),
    )
    .sort(
      (a, b) =>
        b.opened_at.localeCompare(a.opened_at) || a.id.localeCompare(b.id),
    );
  return {
    bills: all.slice((page - 1) * 20, page * 20),
    total: all.length,
    page,
    page_size: 20,
  };
}
export async function getBillDetail(id: string): Promise<BillDetail> {
  const bill = (await rows()).find((b) => b.id === id);
  if (!bill) throw new DataError("NOT_FOUND", "账单不存在");
  return {
    bill,
    orders: allLiveOrders(bill.store_id).filter((o) => o.bill_id === id),
  };
}
export async function markBillPaid(
  id: string,
  expected: number,
): Promise<CheckoutResult> {
  await storeContext(true);
  const { bill } = await getBillDetail(id);
  if (bill.status === "paid")
    throw new DataError("BILL_ALREADY_PAID" as ErrorCode, "账单已付款");
  if (bill.total_cents !== expected)
    throw new DataError("BILL_TOTAL_CHANGED" as ErrorCode, "金额已变化", {
      ...bill,
    });
  const state = readState(),
    b = state.bills.find((b) => b.id === id)!;
  b.status = "paid";
  const paid_at = new Date().toISOString();
  (b as BillWithSnapshot).merchant_snapshot = {
    ...bill,
    status: "paid",
    paid_at,
    updated_at: paid_at,
    is_estimate: false,
  };
  const tokens = state.tokens.filter((t) => t.bill_id === id && !t.reason);
  tokens.forEach((t) => {
    t.reason = "bill_paid";
  });
  saveState(state);
  return {
    ...bill,
    status: "paid",
    paid_at,
    tokens_revoked: tokens.length,
    is_estimate: false,
  };
}
