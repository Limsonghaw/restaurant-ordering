import type { BillAmounts, LiveOrder } from "../types";
export interface TableQrLink {
  table_id: string;
  label: string;
  url: string;
}
export interface DailyStats {
  date: string;
  timezone: "Asia/Kuala_Lumpur";
  currency: "MYR";
  revenue_cents: number;
  paid_bills: BillAmounts & { count: number };
  open_bills: { count: number; subtotal_cents: number; total_cents: number };
  orders: { count: number; cancelled_count: number };
}
export interface StoreHistory {
  orders: LiveOrder[];
  stats: DailyStats;
}
