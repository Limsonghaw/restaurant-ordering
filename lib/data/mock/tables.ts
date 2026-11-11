import { renameStoreTable, setStoreTableActive } from "./store-d";
import { storeContext } from "./menu-c";
import { readState, saveState } from "./state";
import type { DiningTable } from "../types";
export {
  listStoreTables as listTables,
  createStoreTable as createTable,
  softDeleteStoreTable as deleteTable,
  rotateStoreTableQr as rotateTableQr,
} from "./store-d";
export async function updateTable(
  id: string,
  patch: Partial<Pick<DiningTable, "label" | "is_active" | "sort_order">>,
): Promise<void> {
  if (patch.label !== undefined) await renameStoreTable(id, patch.label);
  if (patch.is_active !== undefined)
    await setStoreTableActive(id, patch.is_active);
  if (patch.sort_order !== undefined) {
    const store = await storeContext(true),
      state = readState();
    const table = state.tables.find((t) => t.id === id && t.store_id === store);
    if (table) {
      state.tables = state.tables.filter((t) => t !== table);
      state.tables.splice(
        Math.max(0, Math.floor(patch.sort_order / 10)),
        0,
        table,
      );
      saveState(state);
    }
  }
}
