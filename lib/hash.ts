import { createHash, createHmac } from "node:crypto";
export function secret(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error("Missing server configuration");
  return value;
}
export const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const clientHash = (storeId: string, value: string) =>
  createHmac("sha256", secret("CLIENT_HASH_SECRET"))
    .update(`${storeId}:${value}`)
    .digest("hex");
export function requestHash(
  tableId: string,
  items: {
    item_id: string;
    quantity: number;
    unit_price_cents: number;
    note?: string;
  }[],
) {
  return sha256(
    JSON.stringify({
      table_id: tableId,
      items: items.map((i) => ({
        item_id: i.item_id,
        quantity: i.quantity,
        unit_price_cents: i.unit_price_cents,
        note: i.note ?? "",
      })),
    }),
  );
}
