"use server";
import type { TableQrLink } from "./history-types";
import { createClient } from "../../supabase/server";
import { AppError } from "../../api/errors";
import { signTableCode, uuidPattern } from "../../qr";
export async function getStoreTableQrLinks(
  tableIds: string[],
): Promise<TableQrLink[]> {
  if (
    !Array.isArray(tableIds) ||
    !tableIds.length ||
    tableIds.length > 200 ||
    tableIds.some((id) => typeof id !== "string" || !uuidPattern.test(id))
  )
    throw new AppError("VALIDATION_FAILED");
  const client = await createClient();
  const { data: context, error } = await client.rpc("get_my_context");
  if (error || !context?.store?.id) throw new AppError("FORBIDDEN");
  const store = context.store.id;
  const { data: tables, error: tableError } = await client
    .from("dining_tables")
    .select("id,label,qr_version")
    .eq("store_id", store)
    .is("deleted_at", null)
    .in("id", tableIds);
  if (tableError) throw new AppError("INTERNAL");
  if (
    !tables ||
    new Set(tables.map((t) => t.id)).size !== new Set(tableIds).size
  )
    throw new AppError("NOT_FOUND");
  if (!process.env.NEXT_PUBLIC_SITE_URL)
    throw new Error("NEXT_PUBLIC_SITE_URL is required for table QR links");
  const site = new URL(process.env.NEXT_PUBLIC_SITE_URL);
  if (!["https:", "http:"].includes(site.protocol))
    throw new Error("NEXT_PUBLIC_SITE_URL must be an HTTP(S) URL");
  const origin = site.origin;
  return tables.map((table) => ({
    table_id: table.id,
    label: table.label,
    url: `${origin}/t/${signTableCode({ store_id: store, table_id: table.id, qr_version: table.qr_version })}`,
  }));
}
