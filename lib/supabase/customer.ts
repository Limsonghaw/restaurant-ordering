import { isNonLocalEnv } from "../env";
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
  const local = ["localhost", "127.0.0.1"].includes(new URL(url).hostname);
  return process.env.CUSTOMER_DB_SSL === "disable" && local && !isNonLocalEnv()
    ? false : "require";
}
class MissingCustomerDatabaseConfiguration extends Error {}
class InvalidCustomerDatabaseConfiguration extends Error {}

function database() {
  const url = process.env.CUSTOMER_API_DATABASE_URL;
  if (!url) throw new MissingCustomerDatabaseConfiguration();
  const parsed = URL.parse(url);
  if (!parsed || !["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname)
    throw new InvalidCustomerDatabaseConfiguration();
  return (sql ??= postgres(url, {
    max: 1,
    prepare: false,
    ssl: customerDatabaseSsl(url),
    idle_timeout: 20,
    connect_timeout: 5,
  }));
}
const safeTransportCodes = new Set([
  "CONNECT_TIMEOUT", "CONNECTION_CLOSED", "CONNECTION_DESTROYED",
  "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
  "ENETUNREACH", "EHOSTUNREACH", "ERR_TLS_CERT_ALTNAME_INVALID",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_HAS_EXPIRED",
]);

export function customerDatabaseDiagnostic(error: unknown, rawCode: unknown) {
  if (error instanceof MissingCustomerDatabaseConfiguration)
    return { category: "configuration", code: "missing_database_url" };
  if (error instanceof InvalidCustomerDatabaseConfiguration)
    return { category: "configuration", code: "invalid_database_url" };
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  if (typeof rawCode !== "string") rawCode = cause?.code;
  if (typeof rawCode !== "string" ||
      (!safeTransportCodes.has(rawCode) && !/^[0-9][0-9A-Z]{4}$/.test(rawCode))) {
    // Match known runtime errors, but never put their text in the logs.
    const message = (error as { message?: unknown } | null)?.message;
    if (typeof message === "string") {
      if (/Cannot perform I\/O on behalf of a different request/i.test(message))
        return { category: "connection", code: "cross_request_io" };
      if (/proxy request failed, cannot connect to the specified address/i.test(message))
        return { category: "connection", code: "worker_socket_connect_failed" };
      if (/TLS handshake|certificate verify failed/i.test(message))
        return { category: "connection", code: "tls_failure" };
    }
    return { category: "unknown" };
  }
  if (safeTransportCodes.has(rawCode))
    return { category: "connection", code: rawCode };
  if (!/^[0-9][0-9A-Z]{4}$/.test(rawCode) || rawCode.length !== 5)
    return { category: "unknown" };
  if (rawCode.startsWith("28"))
    return { category: "authentication", code: rawCode };
  if (rawCode.startsWith("08"))
    return { category: "connection", code: rawCode };
  return { category: "database", code: rawCode };
}

export function mapCustomerError(error: unknown, stage?: string): AppError {
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
  console.error("Customer database request failed", { ...customerDatabaseDiagnostic(error, e?.code), ...(stage ? { stage } : {}) });
  return new AppError("INTERNAL");
}
async function call<T>(
  run: (
    db: ReturnType<typeof postgres>,
  ) => PromiseLike<postgres.RowList<postgres.Row[]>>,
): Promise<T> {
  let stage = "initialize_client";
  try {
    const db = database();
    stage = "execute_query";
    const rows = await run(db);
    stage = "read_result";
    return rows[0].result as T;
  } catch (e) {
    throw mapCustomerError(e, stage);
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
