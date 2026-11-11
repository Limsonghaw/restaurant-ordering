import { DataError, type BlockedClientRow } from "../types";
import { delay, readState, saveState } from "./state";
import { storeContext } from "./menu-c";
// M14/R12 rpc('list_blocked_clients', { p_include_expired: false }); never expose hashes.
export async function listBlockedClients(): Promise<BlockedClientRow[]> {
  await delay();
  const store = await storeContext();
  const s = readState();
  return s.blocks
    .filter(
      (b) => b.store_id === store && Date.parse(b.expires_at) > Date.now(),
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 200)
    .map((b) => {
      const bill = s.bills.find((x) =>
        x.orders.some((o) => o.id === b.source_order_id),
      );
      const order = bill?.orders.find((o) => o.id === b.source_order_id);
      return {
        id: b.id,
        kind: b.kind,
        reason: b.reason,
        created_at: b.created_at,
        expires_at: b.expires_at,
        is_active: true,
        source_order: order
          ? {
              id: order.id,
              seq_in_bill: order.seq_in_bill,
              table_label:
                s.tables.find((t) => t.id === bill?.table_id)?.label ?? "",
              subtotal_cents: order.subtotal_cents,
              created_at: order.created_at,
            }
          : null,
      };
    });
}
// R13 rpc('unblock_client', { p_block_id }); not a direct delete.
export async function unblockClient(
  id: string,
): Promise<{ id: string; unblocked: true }> {
  await delay();
  const store = await storeContext(true);
  const s = readState();
  const b = s.blocks.find(
    (b) =>
      b.id === id &&
      b.store_id === store &&
      Date.parse(b.expires_at) > Date.now(),
  );
  if (!b) throw new DataError("NOT_FOUND", "拉黑记录不存在");
  s.blocks = s.blocks.filter((x) => x !== b);
  saveState(s);
  return { id, unblocked: true };
}
// R9 block_client_from_order(p_order_id,p_cancel=true,p_include_ip=false,p_days=7).
export async function blockClientFromOrder(order_id: string) {
  await delay();
  const store = await storeContext(true);
  const s = readState();
  const bill = s.bills.find(
    (b) =>
      s.tables.some((t) => t.id === b.table_id && t.store_id === store) &&
      b.orders.some((o) => o.id === order_id),
  );
  const order = bill?.orders.find((o) => o.id === order_id);
  if (!order) throw new DataError("NOT_FOUND", "这张订单已被处理");
  if (bill?.status === "paid" || !["new", "accepted"].includes(order.status))
    throw new DataError("VALIDATION_FAILED", "这张订单已被处理");
  order.status = "cancelled";
  order.cancel_reason = "other";
  s.blocks.push({
    id: crypto.randomUUID(),
    store_id: store,
    kind: "device",
    device_id: order.device_id,
    reason: "",
    source_order_id: order_id,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
  });
  saveState(s);
  return { blocked: true, cancelled: true };
}
export async function blocksMockAction(expire: boolean) {
  const s = readState();
  if (expire)
    s.blocks.forEach((b) => {
      b.expires_at = new Date(0).toISOString();
    });
  else
    s.blocks.push({
      id: crypto.randomUUID(),
      store_id: "store-0",
      kind: "device",
      device_id: s.device_id,
      reason: "",
      source_order_id: null,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
    });
  saveState(s);
}
