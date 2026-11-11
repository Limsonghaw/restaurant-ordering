import { getClient } from "./me";
import { DataError, type BlockedClientRow } from "../types";
import type * as Mock from "../mock/blocks-c";
import { result } from "./pg-errors";

export const listBlockedClients: typeof Mock.listBlockedClients = async () => {
  const rows = await result<BlockedClientRow[]>((await getClient()).rpc("list_blocked_clients", { p_include_expired: false }));
  // Explicit projection also prevents accidental disclosure if the RPC grows.
  return rows.map(b => ({ id: b.id, kind: b.kind, reason: b.reason, created_at: b.created_at,
    expires_at: b.expires_at, is_active: b.is_active, source_order: b.source_order ? {
      id: b.source_order.id, seq_in_bill: b.source_order.seq_in_bill, table_label: b.source_order.table_label,
      subtotal_cents: b.source_order.subtotal_cents, created_at: b.source_order.created_at,
    } : null }));
};
export const unblockClient: typeof Mock.unblockClient = async id =>
  result((await getClient()).rpc("unblock_client", { p_block_id: id }));
export const blockClientFromOrder: typeof Mock.blockClientFromOrder = async order_id => {
  const row = await result<{ blocked: number; cancelled: boolean }>((await getClient()).rpc("block_client_from_order", {
    p_order_id: order_id, p_cancel: true, p_include_ip: false, p_days: 7,
  }));
  // PR-C declares the mock's boolean signature. Preserve that public contract;
  // database count 0 must become false (including already-processed orders).
  return { blocked: row.blocked > 0, cancelled: row.cancelled };
};
export const blocksMockAction: typeof Mock.blocksMockAction = async () => { throw new DataError("NOT_IMPLEMENTED", "未实现"); };
// R9: 0004 returns { blocked: number, cancelled: boolean }; served/cancelled
// orders may still be blocked, e.g. { blocked: 1, cancelled: false }.
// Closed bills raise ORDER_BILL_CLOSED (mock currently uses VALIDATION_FAILED).
// PR5 will align those mock semantics; this adapter preserves the PR-C signature.
