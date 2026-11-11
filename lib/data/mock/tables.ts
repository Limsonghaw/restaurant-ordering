import { DataError, type DiningTable } from "../types";
import { storeContext } from "./menu-c";
import { readState, saveState } from "./state";
export async function listTables(): Promise<DiningTable[]> {
  const store = await storeContext();
  return readState()
    .tables.filter((t) => t.store_id === store)
    .map((t, i) => ({
      id: t.id,
      label: t.label,
      is_active: t.active,
      qr_version: t.rotations + 1,
      sort_order: i * 10,
    }));
}
export async function createTable(label: string): Promise<string> {
  const store = await storeContext(true),
    state = readState();
  if (!label.trim()) throw new DataError("VALIDATION_FAILED", "请填写桌名");
  if (
    state.tables.some((t) => t.store_id === store && t.label === label.trim())
  )
    throw new DataError("VALIDATION_FAILED", "桌名已存在");
  const id = crypto.randomUUID();
  state.tables.push({
    id,
    label: label.trim(),
    store_id: store,
    active: true,
    rotations: 0,
    code: id,
    original_code: id,
  });
  saveState(state);
  return id;
}
export async function updateTable(
  id: string,
  patch: Partial<Pick<DiningTable, "label" | "is_active" | "sort_order">>,
): Promise<void> {
  const store = await storeContext(true),
    state = readState(),
    table = state.tables.find((t) => t.id === id && t.store_id === store);
  if (!table) throw new DataError("NOT_FOUND", "桌子不存在");
  if (patch.label !== undefined) table.label = patch.label;
  if (patch.is_active !== undefined) table.active = patch.is_active;
  if (patch.sort_order !== undefined) {
    state.tables = state.tables.filter((t) => t !== table);
    state.tables.splice(
      Math.max(0, Math.floor(patch.sort_order / 10)),
      0,
      table,
    );
  }
  saveState(state);
}
export async function deleteTable(id: string): Promise<void> {
  const store = await storeContext(true),
    state = readState();
  if (!state.tables.some((t) => t.id === id && t.store_id === store))
    throw new DataError("NOT_FOUND", "桌子不存在");
  if (state.bills.some((b) => b.table_id === id && b.status === "open"))
    throw new DataError("ORDER_BILL_CLOSED", "桌子还有未结账单");
  state.tables = state.tables.filter((t) => t.id !== id);
  saveState(state);
}
export async function rotateTableQr(
  id: string,
): Promise<{ table_id: string; qr_version: number; tokens_revoked: number }> {
  const store = await storeContext(true),
    state = readState(),
    table = state.tables.find((t) => t.id === id && t.store_id === store);
  if (!table) throw new DataError("NOT_FOUND", "桌子不存在");
  table.rotations++;
  table.code = table.original_code + "-" + table.rotations;
  const tokens = state.tokens.filter((t) => t.table_id === id && !t.reason);
  tokens.forEach((t) => {
    t.reason = "qr_rotated";
  });
  saveState(state);
  return {
    table_id: id,
    qr_version: table.rotations + 1,
    tokens_revoked: tokens.length,
  };
}
