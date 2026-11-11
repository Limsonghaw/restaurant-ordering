import type { Store, StoreProfilePatch } from "../types";
import { DataError } from "../types";
import { storeContext } from "./menu-c";
import { readState, saveState } from "./state";
export async function getStore(): Promise<Store> {
  const id = await storeContext();
  const store = readState().stores.find((s) => s.id === id);
  if (!store) throw new DataError("NOT_FOUND", "店铺不存在");
  return store;
}
export async function updateStore(patch: StoreProfilePatch): Promise<void> {
  const id = await storeContext(true),
    state = readState();
  const store = state.stores.find((s) => s.id === id)!;
  for (const key of [
    "name",
    "logo_path",
    "address",
    "opening_hours",
    "is_accepting_orders",
    "service_charge_bp",
    "sst_bp",
  ] as const) {
    if (Object.hasOwn(patch, key)) Object.assign(store, { [key]: patch[key] });
  }
  store.is_profile_complete =
    !!store.address.trim() && !!store.opening_hours.trim();
  store.updated_at = new Date().toISOString();
  saveState(state);
}
export async function setAcceptingOrders(value: boolean): Promise<void> {
  await updateStore({ is_accepting_orders: value });
}
