import { listStoreBills, getStoreBill, checkoutMockBill } from "./store-d";
import { DataError } from "../types";
import type {
  BillFilters,
  BillPage,
  BillDetail,
  BillListRow,
  CheckoutResult,
} from "../types";
// One shared settlement snapshot, including payments made by mock control panels.
export async function listBills(filters: BillFilters = {}): Promise<BillPage> {
  const statuses = filters.status
    ? [filters.status]
    : (["open", "paid"] as const);
  const rows: BillListRow[] = [];
  for (const status of statuses) {
    let page = 1;
    while (true) {
      const result = await listStoreBills(status, page++, {
        table_id: filters.table_id,
      });
      rows.push(...(result.bills as BillListRow[]));
      if ((page - 1) * 20 >= result.total) break;
    }
  }
  const page = filters.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1) {
    throw new DataError("VALIDATION_FAILED", "页码无效");
  }
  const all = rows
    .filter(
      (b) =>
        (!filters.paid_from ||
          (!!b.paid_at &&
            Date.parse(b.paid_at) >=
              Date.parse(filters.paid_from + "T00:00:00+08:00"))) &&
        (!filters.paid_to ||
          (!!b.paid_at &&
            Date.parse(b.paid_at) <
              Date.parse(filters.paid_to + "T00:00:00+08:00") + 86400000)),
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
  const { orders, ...bill } = await getStoreBill(id);
  return { bill: bill as BillListRow, orders };
}
export async function markBillPaid(
  id: string,
  expected: number,
): Promise<CheckoutResult> {
  const paid = await checkoutMockBill(id, expected);
  return { ...paid, paid_at: paid.paid_at!, is_estimate: false };
}
