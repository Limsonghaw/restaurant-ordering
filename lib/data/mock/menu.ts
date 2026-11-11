import {
  DataError,
  type CartItem,
  type CartQuote,
  type TableMenu,
} from "../types";
import { type State } from "./seed";
import { calculateAmounts } from "./money";
import { delay, readState, tableFor } from "./state";
// 相同 sort_order 按 id 升序，保证稳定排序。
// C1
export async function getTableMenu(code: string): Promise<TableMenu> {
  await delay();
  const state = readState();
  const { table, store } = tableFor(state, code);
  const {
    id,
    name,
    logo_path,
    address,
    opening_hours,
    is_accepting_orders,
    currency,
    service_charge_bp,
    sst_bp,
  } = store;
  return {
    store: {
      id,
      name,
      logo_path,
      address,
      opening_hours,
      is_accepting_orders,
      currency,
      service_charge_bp,
      sst_bp,
    },
    table: { id: table.id, label: table.label },
    categories: state.categories
      .filter((c) => c.store_id === store.id && !c.hidden && !c.deleted)
      .sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id))
      .map(({ id, name, sort_order }) => ({ id, name, sort_order })),
    items: state.items
      .filter(
        (i) =>
          i.store_id === store.id &&
          !i.hidden &&
          !i.deleted &&
          state.categories.some(
            (c) =>
              c.store_id === store.id &&
              c.id === i.category_id &&
              !c.hidden &&
              !c.deleted,
          ),
      )
      .sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id))
      .map(
        ({
          id,
          category_id,
          name,
          description,
          price_cents,
          image_path,
          thumb_path,
          is_sold_out,
          sort_order,
        }) => ({
          id,
          category_id,
          name,
          description,
          price_cents,
          image_path,
          thumb_path,
          is_sold_out,
          sort_order,
        }),
      ),
    table_in_use: state.bills.some(
      (b) => b.table_id === table.id && b.status === "open",
    ),
  };
}
export function validateItems(items: CartItem[]) {
  // 最终以后端校验为准。
  if (
    !Array.isArray(items) ||
    items.some(
      (i) =>
        !Number.isInteger(i.quantity) ||
        i.quantity < 1 ||
        i.quantity > 99 ||
        typeof i.note !== "string" ||
        i.note.length > 50 ||
        !Number.isInteger(i.unit_price_cents),
    )
  )
    throw new DataError("VALIDATION_FAILED", "请检查数量或备注（最多 50 字）");
}
export function quote(
  state: State,
  code: string,
  items: CartItem[],
): CartQuote {
  validateItems(items);
  const { store } = tableFor(state, code);
  const unavailable: CartQuote["unavailable"] = [];
  const price_changes: CartQuote["price_changes"] = [];
  const lines = items.map((line, index) => {
    const item = state.items.find(
      (i) => i.id === line.item_id && i.store_id === store.id,
    );
    const visible =
      item &&
      !item.hidden &&
      !item.deleted &&
      state.categories.some(
        (c) =>
          c.store_id === store.id &&
          c.id === item.category_id &&
          !c.hidden &&
          !c.deleted,
      );
    if (!visible || item.is_sold_out)
      unavailable.push({
        item_id: line.item_id,
        name: item?.name ?? "已下架菜品",
        reason: visible ? "sold_out" : "unavailable",
      });
    if (visible && item.price_cents !== line.unit_price_cents)
      price_changes.push({
        item_id: item.id,
        name: item.name,
        client_unit_price_cents: line.unit_price_cents,
        current_unit_price_cents: item.price_cents,
      });
    const unit_price_cents = visible ? item.price_cents : 0;
    return {
      line_no: index + 1,
      item_id: line.item_id,
      item_name: item?.name ?? "已下架菜品",
      unit_price_cents,
      quantity: line.quantity,
      line_total_cents: unit_price_cents * line.quantity,
      note: line.note,
    };
  });
  const item_count = lines.reduce((n, l) => n + l.quantity, 0);
  const subtotal_cents = lines.reduce((n, l) => n + l.line_total_cents, 0);
  const limit_exceeded =
    subtotal_cents > 300000 || item_count > 200 || items.length > 30;
  const amounts = calculateAmounts(
    subtotal_cents,
    store.service_charge_bp,
    store.sst_bp,
  );
  return {
    lines,
    item_count,
    subtotal_cents,
    can_order:
      items.length > 0 &&
      !limit_exceeded &&
      !unavailable.length &&
      !price_changes.length &&
      store.is_accepting_orders,
    is_accepting_orders: store.is_accepting_orders,
    limit_exceeded,
    unavailable,
    price_changes,
    max_order_cents: 300000,
    estimate_basis: "this_order",
    service_charge_bp: store.service_charge_bp,
    sst_bp: store.sst_bp,
    estimated_service_charge_cents: limit_exceeded
      ? null
      : amounts.service_charge_cents,
    estimated_sst_cents: limit_exceeded ? null : amounts.sst_cents,
    estimated_rounding_cents: limit_exceeded ? null : 0,
    estimated_total_cents: limit_exceeded ? null : amounts.total_cents,
  };
}
// C2
export async function quoteCart(code: string, items: CartItem[]) {
  await delay();
  return quote(readState(), code, items);
}
export function imageUrl(path: string | null) {
  if (path === "/mock/missing.svg") return null;
  return path &&
    (path.startsWith("/mock/") || path.startsWith("data:image/webp;base64,"))
    ? path
    : null;
}
