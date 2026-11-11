import type {
  LiveOrder,
  OrderStatusChange,
  LiveStoreStatus,
  StoreOrderCallbacks,
} from "../types";
import { getClient, storeContext } from "./me";
import { dataError, result } from "./pg-errors";
import { malaysiaDay } from "../live-rules";
export const ORDER_COLUMNS =
  "id,store_id,table_id,bill_id,seq_in_bill,device_seq_in_bill,status,subtotal_cents,item_count,created_at,accepted_at,served_at,cancelled_at,updated_at,cancel_reason,cancel_note,order_items(item_name,unit_price_cents,quantity,line_total_cents,note),dining_tables(label)";
async function ordersQuery() {
  const id = await storeContext();
  return { client: await getClient(), id };
}
export async function listLiveOrders(): Promise<LiveOrder[]> {
  const { client, id } = await ordersQuery();
  return result(
    client
      .from("orders")
      .select(ORDER_COLUMNS)
      .eq("store_id", id)
      .in("status", ["new", "accepted"])
      .order("created_at")
      .order("id")
      .returns<LiveOrder[]>(),
  );
}
export async function listServedToday(): Promise<LiveOrder[]> {
  const { client, id } = await ordersQuery();
  const { start, end } = malaysiaDay();
  return result(
    client
      .from("orders")
      .select(ORDER_COLUMNS)
      .eq("store_id", id)
      .eq("status", "served")
      .gte("served_at", new Date(start).toISOString())
      .lt("served_at", new Date(end).toISOString())
      .order("served_at", { ascending: false })
      .order("id")
      .returns<LiveOrder[]>(),
  );
}
export async function fetchOrdersUpdatedSince(
  since: string,
): Promise<LiveOrder[]> {
  const { client, id } = await ordersQuery();
  return result(
    client
      .from("orders")
      .select(ORDER_COLUMNS)
      .eq("store_id", id)
      .gt("updated_at", since)
      .order("updated_at")
      .order("id")
      .returns<LiveOrder[]>(),
  );
}
export async function updateOrderStatus(
  order_id: string,
  change: OrderStatusChange,
): Promise<LiveOrder> {
  if (
    change.to === "cancelled" &&
    (!change.cancel_reason ||
      !["sold_out", "customer_request", "duplicate", "other"].includes(
        change.cancel_reason,
      ) ||
      Array.from(change.cancel_note ?? "").length > 100)
  )
    throw dataError("VALIDATION_FAILED");
  const id = await storeContext(true),
    client = await getClient();
  await result(
    client.rpc("update_order_status", {
      p_order_id: order_id,
      p_to: change.to,
      p_expected: change.expected,
      p_cancel_reason: change.cancel_reason ?? null,
      p_cancel_note: change.cancel_note ?? null,
    }),
  );
  const order = await result<LiveOrder | null>(
    client
      .from("orders")
      .select(ORDER_COLUMNS)
      .eq("store_id", id)
      .eq("id", order_id)
      .returns<LiveOrder[]>()
      .maybeSingle(),
  );
  if (!order) throw dataError("NOT_FOUND");
  return order;
}
export async function getStoreStatus(): Promise<LiveStoreStatus> {
  const id = await storeContext();
  const row = await result<LiveStoreStatus | null>(
    (await getClient())
      .from("stores")
      .select("name, status, is_accepting_orders")
      .eq("id", id)
      .maybeSingle(),
  );
  if (!row) throw dataError("NOT_FOUND");
  return row;
}
export async function setAcceptingOrders(
  value: boolean,
): Promise<LiveStoreStatus> {
  const id = await storeContext(true);
  if (typeof value !== "boolean") throw dataError("VALIDATION_FAILED");
  const row = await result<LiveStoreStatus | null>(
    (await getClient())
      .from("stores")
      .update({ is_accepting_orders: value })
      .eq("id", id)
      .select("name, status, is_accepting_orders")
      .maybeSingle(),
  );
  if (!row) throw dataError("NOT_FOUND");
  return row;
}
export function subscribeStoreOrders(
  store_id: string,
  callbacks: StoreOrderCallbacks,
): () => void {
  let stopped = false;
  let cleanup = () => {};
  void (async () => {
    if ((await storeContext()) !== store_id) throw dataError("FORBIDDEN");
    const client = await getClient();
    await client.realtime.setAuth();
    if (stopped) return;
    const channel = client.channel("store:" + store_id, {
      config: { private: true },
    });
    cleanup = () => {
      void client.removeChannel(channel);
    };
    const refresh = async (orderId?: string, insert = false) => {
      if (stopped) return;
      try {
        let query = client
          .from("orders")
          .select(ORDER_COLUMNS)
          .eq("store_id", store_id);
        if (orderId) query = query.eq("id", orderId);
        const rows = await result<LiveOrder[]>(query.returns<LiveOrder[]>());
        if (!stopped)
          for (const row of rows)
            (insert ? callbacks.onInsert : callbacks.onUpdate)(row);
      } catch {
        if (!stopped) callbacks.onConnectionChange("disconnected");
      }
    };
    channel
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "orders",
          filter: "store_id=eq." + store_id,
        },
        (payload) => {
          void refresh(
            payload.new && "id" in payload.new
              ? String(payload.new.id)
              : undefined,
            payload.eventType === "INSERT",
          );
        },
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "bills",
          filter: "store_id=eq." + store_id,
        },
        () => {
          void refresh();
        },
      )
      .subscribe((status) => {
        if (!stopped)
          callbacks.onConnectionChange(
            status === "SUBSCRIBED" ? "connected" : "disconnected",
          );
      });
  })().catch(() => {
    if (!stopped) callbacks.onConnectionChange("disconnected");
  });
  return () => {
    stopped = true;
    cleanup();
  };
}
