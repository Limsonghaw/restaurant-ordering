"use server";
import { createClient } from "../../../lib/supabase/server";
import { AppError } from "../../../lib/api/errors";
import { signTableCode, uuidPattern } from "../../../lib/qr";
export async function getTableQrLinks(tableIds: string[]) {
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
  const origin = new URL(process.env.NEXT_PUBLIC_SITE_URL!).origin;
  return tables.map((table) => ({
    table_id: table.id,
    label: table.label,
    url: `${origin}/t/${signTableCode({ store_id: store, table_id: table.id, qr_version: table.qr_version })}`,
  }));
}
