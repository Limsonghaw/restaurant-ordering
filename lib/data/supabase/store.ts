import type { Store, StoreProfilePatch } from "../types";
import { getClient, storeContext } from "./me";
import { dataError, result } from "./pg-errors";

export const STORE_COLUMNS = "id,slug,name,logo_path,address,opening_hours,is_accepting_orders,status,status_changed_at,currency,locale,timezone,service_charge_bp,sst_bp,cash_rounding,require_first_order_approval,max_order_cents,require_captcha,created_at,updated_at,is_profile_complete";
export async function getStore(): Promise<Store> {
  const id = await storeContext();
  const row = await result<Store | null>((await getClient()).from("stores").select(STORE_COLUMNS).eq("id", id).maybeSingle());
  if (!row) throw dataError("NOT_FOUND");
  return row;
}
export async function updateStore(patch: StoreProfilePatch): Promise<void> {
  const id = await storeContext(true);
  // Copy only columns granted to merchants, including when called from untyped JS.
  const values: StoreProfilePatch = {};
  for (const key of ["name", "logo_path", "address", "opening_hours", "is_accepting_orders", "service_charge_bp", "sst_bp"] as const) {
    if (Object.hasOwn(patch, key)) Object.assign(values, { [key]: patch[key] });
  }
  if (!Object.keys(values).length) throw dataError("VALIDATION_FAILED");
  const rows = await result<{ id: string }[]>((await getClient()).from("stores").update(values).eq("id", id).select("id"));
  if (!rows.length) throw dataError("NOT_FOUND");
}
export async function setAcceptingOrders(value: boolean): Promise<void> {
  await updateStore({ is_accepting_orders: value });
}
