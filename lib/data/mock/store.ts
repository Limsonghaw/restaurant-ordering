import { saveStoreProfile } from "./store-d";
import type { StoreProfilePatch } from "../types";
export { getStoreProfile as getStore } from "./store-d";
export async function updateStore(patch: StoreProfilePatch): Promise<void> {
  await saveStoreProfile(patch);
}
export async function setAcceptingOrders(value: boolean): Promise<void> {
  await updateStore({ is_accepting_orders: value });
}
