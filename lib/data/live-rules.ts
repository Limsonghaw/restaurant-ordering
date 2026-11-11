import { DataError, type LiveOrder, type OrderStatusChange } from "./types";
export function validateOrderChange(
  order: LiveOrder,
  change: OrderStatusChange,
  paid: boolean,
) {
  if (order.status !== change.expected)
    throw new DataError("ORDER_STATUS_CONFLICT", "这张订单已被处理", {
      current_status: order.status,
    });
  const valid =
    (order.status === "new" && change.to === "accepted") ||
    (order.status === "accepted" && change.to === "served") ||
    (["new", "accepted"].includes(order.status) && change.to === "cancelled");
  if (!valid)
    throw new DataError("INVALID_STATUS_TRANSITION", "这张订单已被处理", {
      current_status: order.status,
    });
  if (change.to === "cancelled" && paid)
    throw new DataError("ORDER_BILL_CLOSED", "这桌已结账，不能取消订单");
  // 最终以后端校验为准。
  if (
    change.to === "cancelled" &&
    (!change.cancel_reason ||
      !["sold_out", "customer_request", "duplicate", "other"].includes(
        change.cancel_reason,
      ) ||
      (change.cancel_note?.length ?? 0) > 200)
  )
    throw new DataError("VALIDATION_FAILED", "请选择取消原因，说明最多 200 字");
}
export function malaysiaDay(now = Date.now()) {
  const start = Date.parse(
    `${new Date(now + 8 * 3600000).toISOString().slice(0, 10)}T00:00:00+08:00`,
  );
  return { start, end: start + 86400000 };
}
export function mergeLiveOrders(current: LiveOrder[], incoming: LiveOrder[]) {
  const map = new Map(current.map((o) => [o.id, o]));
  for (const order of incoming) {
    const previous = map.get(order.id);
    if (!previous || order.updated_at >= previous.updated_at)
      map.set(order.id, order);
  }
  return [...map.values()].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );
}

export function reconnectDelay(attempt: number) {
  return [1000, 2000, 5000, 10000][attempt] ?? 30000;
}
