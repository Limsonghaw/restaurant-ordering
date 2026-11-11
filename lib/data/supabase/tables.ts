import type { DiningTable } from "../types";
import { getClient, storeContext } from "./me";
import { dataError, result } from "./pg-errors";
const columns = "id,label,is_active,qr_version,sort_order";
export async function listTables(): Promise<DiningTable[]> {
  const store = await storeContext();
  return result((await getClient()).from("dining_tables").select(columns).eq("store_id", store).is("deleted_at", null).order("sort_order").order("id"));
}
export async function createTable(label: string): Promise<string> {
  const store = await storeContext(true);
  const tables = await listTables();
  const sort_order = Math.max(0, ...tables.map(t => t.sort_order)) + 10;
  const row = await result<{ id: string }>((await getClient()).from("dining_tables").insert({ store_id: store, label: label.trim(), sort_order }).select("id").single());
  return row.id;
}
export async function updateTable(id: string, patch: Partial<Pick<DiningTable, "label" | "is_active" | "sort_order">>): Promise<void> {
  const store = await storeContext(true);
  const values = Object.fromEntries(["label", "is_active", "sort_order"].filter(k => Object.hasOwn(patch, k)).map(k => [k, patch[k as keyof typeof patch]]));
  if (!Object.keys(values).length) throw dataError("VALIDATION_FAILED");
  const rows = await result<{ id: string }[]>((await getClient()).from("dining_tables").update(values).eq("id", id).eq("store_id", store).is("deleted_at", null).select("id"));
  if (!rows.length) throw dataError("NOT_FOUND");
}
export async function deleteTable(id: string): Promise<void> {
  await result((await getClient()).rpc("soft_delete_table", { p_table_id: id }));
}
export async function rotateTableQr(id: string): Promise<{ table_id: string; qr_version: number; tokens_revoked: number }> {
  return result((await getClient()).rpc("rotate_table_qr", { p_table_id: id }));
}
