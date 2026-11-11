import type {
  BillFilters,
  BillPage,
  BillListRow,
  BillDetail,
  CheckoutResult,
  LiveOrder,
} from "../types";
import { getClient, storeContext } from "./me";
import { dataError, result } from "./pg-errors";
import { ORDER_COLUMNS } from "./live-orders";
export const BILL_COLUMNS =
  "id,store_id,table_id,table_label,status,opened_at,paid_at,updated_at,subtotal_cents,service_charge_bp,service_charge_cents,sst_bp,sst_cents,rounding_cents,total_cents,is_estimate,order_count,unserved_count,currency";
export function paidDateBoundary(date: string, next = false) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date
  )
    throw dataError("VALIDATION_FAILED");
  return new Date(
    Date.parse(date + "T00:00:00+08:00") + (next ? 86400000 : 0),
  ).toISOString();
}
export async function listBills(filters: BillFilters = {}): Promise<BillPage> {
  const page = filters.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1)
    throw dataError("VALIDATION_FAILED");
  const id = await storeContext();
  let query = (await getClient())
    .from("bill_overview")
    .select(BILL_COLUMNS, { count: "exact" })
    .eq("store_id", id);
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.table_id) query = query.eq("table_id", filters.table_id);
  if (filters.paid_from)
    query = query.gte("paid_at", paidDateBoundary(filters.paid_from));
  if (filters.paid_to)
    query = query.lt("paid_at", paidDateBoundary(filters.paid_to, true));
  // Keep count metadata while retaining the central Postgres error mapping.
  const response = await query
    .order("opened_at", { ascending: false })
    .order("id")
    .range((page - 1) * 20, page * 20 - 1);
  const bills = await result<BillListRow[]>(Promise.resolve(response));
  return { bills, total: response.count ?? 0, page, page_size: 20 };
}
export async function getBillDetail(id: string): Promise<BillDetail> {
  const store = await storeContext(),
    client = await getClient();
  const bill = await result<BillListRow | null>(
    client
      .from("bill_overview")
      .select(BILL_COLUMNS)
      .eq("store_id", store)
      .eq("id", id)
      .maybeSingle(),
  );
  if (!bill) throw dataError("NOT_FOUND");
  const orders = await result<LiveOrder[]>(
    client
      .from("orders")
      .select(ORDER_COLUMNS)
      .eq("store_id", store)
      .eq("bill_id", id)
      .order("seq_in_bill")
      .order("id")
      .returns<LiveOrder[]>(),
  );
  return { bill, orders };
}
export async function markBillPaid(
  id: string,
  expected_total_cents: number,
): Promise<CheckoutResult> {
  if (!Number.isSafeInteger(expected_total_cents) || expected_total_cents < 0)
    throw dataError("VALIDATION_FAILED");
  await storeContext(true);
  return result(
    (await getClient()).rpc("mark_bill_paid", {
      p_bill_id: id,
      p_expected_total_cents: expected_total_cents,
    }),
  );
}
