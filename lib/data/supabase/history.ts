import type { LiveOrder } from "../types";
import type { DailyStats, StoreHistory } from "./history-types";
import { getClient, storeContext } from "./me";
import { dataError, result } from "./pg-errors";
import { malaysiaDay } from "../live-rules";
import { ORDER_COLUMNS } from "./live-orders";

export async function getStoreHistory(date: string): Promise<StoreHistory> {
  const start = Date.parse(`${date}T00:00:00+08:00`);
  if (
    typeof date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(start) ||
    new Date(start + 8 * 3600000).toISOString().slice(0, 10) !== date ||
    start > malaysiaDay().start
  )
    throw dataError("VALIDATION_FAILED");
  let store: string;
  try {
    store = await storeContext();
  } catch (error) {
    if ((error as { code?: string }).code === "UNAUTHENTICATED")
      throw dataError("FORBIDDEN");
    throw error;
  }
  const client = await getClient();
  const stats = await result<DailyStats>(
    client.rpc("get_store_daily_stats", { p_date: date }),
  );
  const orders: LiveOrder[] = [];
  let cursor: LiveOrder | undefined;
  for (;;) {
    let query = client
      .from("orders")
      .select(ORDER_COLUMNS)
      .eq("store_id", store)
      .gte("created_at", new Date(start).toISOString())
      .lt("created_at", new Date(start + 86400000).toISOString());
    if (cursor)
      query = query.or(
        `created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.gt.${cursor.id})`,
      );
    const page = await result<LiveOrder[]>(
      query
        .order("created_at", { ascending: false })
        .order("id")
        .limit(500)
        .returns<LiveOrder[]>(),
    );
    orders.push(...page);
    if (page.length < 500) break;
    cursor = page[page.length - 1];
  }
  return { orders, stats };
}
