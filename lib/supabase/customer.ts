import postgres from "postgres";
import { AppError, ERRORS, type AppCode } from "../api/errors";
import type { TableCode } from "../qr";
import type { CartLine } from "../api/schemas";
import type {
  TableMenu,
  CartQuote,
  PlaceOrderResult,
  TableBill,
} from "../data/types";
let sql: ReturnType<typeof postgres> | undefined;
export function customerDatabaseSsl(url: string): "require" | false {
  const local = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(new URL(url).hostname);
  return process.env.CUSTOMER_DB_SSL === "disable" && local &&
    process.env.NODE_ENV !== "production" && process.env.VERCEL_ENV !== "production"
    ? false : "require";
}
function database() {
  if (!process.env.CUSTOMER_API_DATABASE_URL)
    throw new Error("Missing database configuration");
  return (sql ??= postgres(process.env.CUSTOMER_API_DATABASE_URL, {
    max: 1,
    prepare: false,
    ssl: customerDatabaseSsl(process.env.CUSTOMER_API_DATABASE_URL),
    idle_timeout: 20,
    connect_timeout: 5,
  }));
}
export function mapCustomerError(error: unknown): AppError {
  const e = error as { code?: string; message?: string; detail?: string };
  if (e?.code === "P0001" && e.message && Object.hasOwn(ERRORS, e.message)) {
    const code = e.message as AppCode;
    const result = new AppError(code);
    // Only documented business details survive. Never spread arbitrary database JSON.
    try {
      const raw = JSON.parse(e.detail ?? "{}");
      const details: Record<string, unknown> = {};
      if (
        code === "BILL_TOKEN_EXPIRED" &&
        ["bill_paid", "qr_rotated", "expired"].includes(raw.reason)
      )
        details.reason = raw.reason;
      if (
        ["PRICE_CHANGED", "ITEM_UNAVAILABLE"].includes(code) &&
        Array.isArray(raw.items)
      )
        details.items = raw.items.map((item: Record<string, unknown>) =>
          Object.fromEntries(
            (code === "PRICE_CHANGED"
              ? [
                  "item_id",
                  "name",
                  "client_unit_price_cents",
                  "current_unit_price_cents",
                ]
              : ["item_id", "reason", "name"]
            )
              .filter((k) => Object.hasOwn(item, k))
              .map((k) => [k, item[k]]),
          ),
        );
      if (
        ["RATE_LIMITED", "CAPTCHA_REQUIRED"].includes(code) &&
        [
          "ip",
          "ip_db",
          "device",
          "table",
          "store",
          "device_db",
          "table_db",
        ].includes(raw.scope)
      )
        details.scope = raw.scope;
      if (
        code === "RATE_LIMITED" &&
        typeof raw.retry_after_seconds === "number" &&
        Number.isFinite(raw.retry_after_seconds)
      )
        details.retry_after_seconds = Math.max(
          1,
          Math.ceil(raw.retry_after_seconds),
        );
      if (Object.keys(details).length) Object.assign(result, { details });
    } catch {
      /* discard malformed details */
    }
    return result;
  }
  console.error("Customer database request failed", {
    code: e?.code === "57014" ? "timeout" : "unavailable",
  });
  return new AppError("INTERNAL");
}
async function call<T>(
  run: (
    db: ReturnType<typeof postgres>,
  ) => PromiseLike<postgres.RowList<postgres.Row[]>>,
): Promise<T> {
  try {
    const rows = await run(database());
    return rows[0].result as T;
  } catch (e) {
    throw mapCustomerError(e);
  }
}
export const customerGetMenu = (a: TableCode) =>
  call<TableMenu>(
    (db) =>
      db`select public.customer_get_menu(${a.store_id}, ${a.table_id}, ${a.qr_version}) as result`,
  );
export const customerQuote = (a: TableCode, items: CartLine[]) =>
  call<CartQuote>(
    (db) =>
      db`select public.customer_quote(${a.store_id}, ${a.table_id}, ${a.qr_version}, ${db.json(items)}) as result`,
  );
export interface PlaceArgs extends TableCode {
  request_id: string;
  request_hash: string;
  items: CartLine[];
  device_hash: string;
  ip_hash: string;
  bill_token_hash: string | null;
  new_bill_token_hash: string;
  captcha_verified: boolean;
}
function placeQuery(db: ReturnType<typeof postgres>, a: PlaceArgs) {
  return db`select public.customer_place_order(${a.store_id}, ${a.table_id}, ${a.qr_version}, ${a.request_id}, ${a.request_hash}, ${db.json(a.items)}, ${a.device_hash}, ${a.ip_hash}, ${a.bill_token_hash}, ${a.new_bill_token_hash}, ${a.captcha_verified}) as result`;
}
export const customerPlaceOrder = (a: PlaceArgs) =>
  call<PlaceOrderResult>((db) => placeQuery(db, a));

export type ReplayCheck =
  | { status: "replay" }
  | { status: "mismatch"; code: "IDEMPOTENCY_KEY_REUSED" }
  | { status: "missing" };
export const customerCheckReplay = (a: Pick<PlaceArgs,
  "store_id" | "table_id" | "qr_version" | "request_id" | "request_hash" | "device_hash"
>) => call<ReplayCheck>((db) =>
  db`select public.customer_check_replay(${a.store_id}, ${a.table_id}, ${a.qr_version}, ${a.request_id}, ${a.request_hash}, ${a.device_hash}) as result`
);
export const customerGetBill = (
  a: TableCode,
  token: string | null,
  device: string | null,
) =>
  call<TableBill>(
    (db) =>
      db`select public.customer_get_bill(${a.store_id}, ${a.table_id}, ${a.qr_version}, ${token}, ${device}) as result`,
  );
