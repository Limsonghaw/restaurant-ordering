"use server";
import { getStoreTableQrLinks } from "../../../lib/data/supabase/table-qr";
export async function getTableQrLinks(tableIds: string[]) {
  return getStoreTableQrLinks(tableIds);
}
