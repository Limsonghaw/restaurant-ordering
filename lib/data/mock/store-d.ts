import {
  DataError,
  type ErrorCode,
  type StorePageErrorCode,
  type Store,
  type StoreProfilePatch,
  type StoreBillRow,
  type StoreBillDetail,
  type BillPage,
  type DiningTable,
  type TableQrLink,
  type StoreHistory,
  type LiveOrder,
  type StoreMockActionD,
  type StoreBillFilters,
} from "../types";
import { delay, readState, saveState } from "./state";
import { storeContext } from "./menu-c";
import { calculateAmounts } from "./money";
import { seed, type State, type InternalBill } from "./seed";
// Additional contract codes are appended separately to preserve the existing ErrorCode declaration.
function fail(
  code: StorePageErrorCode,
  message: string,
  details = {},
  status = 400,
): never {
  throw new DataError(code as ErrorCode, message, details, status);
}
interface MetaD {
  deleted: Record<string, string>;
  paid: Record<string, StoreBillRow>;
}
const key = "ro-mock:store-d";
function meta(): MetaD {
  return JSON.parse(localStorage.getItem(key) ?? '{"deleted":{},"paid":{}}');
}
function persist(s: State, m: MetaD) {
  saveState(s);
  localStorage.setItem(key, JSON.stringify(m));
  window.dispatchEvent(new Event("ro-mock:change"));
}
async function context(write = false) {
  await delay();
  const id = await storeContext(write);
  const s = readState();
  const store = s.stores.find((x) => x.id === id);
  if (!store) fail("NOT_FOUND", "店铺不存在", {}, 404);
  return { s, store, m: meta() };
}
function table(s: State, m: MetaD, store: string, id: string) {
  const t = s.tables.find(
    (x) => x.id === id && x.store_id === store && !m.deleted[x.id],
  );
  if (!t) fail("NOT_FOUND", "桌号不存在", {}, 404);
  return t;
}
function bill(s: State, store: string, id: string) {
  const b = s.bills.find(
    (x) =>
      x.id === id &&
      s.tables.some((t) => t.id === x.table_id && t.store_id === store),
  );
  if (!b) fail("NOT_FOUND", "账单不存在", {}, 404);
  return b;
}
function overview(
  s: State,
  store: Store,
  m: MetaD,
  b: InternalBill,
): StoreBillRow {
  const counts = {
    order_count: b.orders.length,
    unserved_count: b.orders.filter(
      (o) => o.status === "new" || o.status === "accepted",
    ).length,
    is_estimate: b.status === "open",
  };
  if (b.status === "paid" && m.paid[b.id])
    return { ...m.paid[b.id], ...counts };
  const subtotal = b.orders
    .filter((o) => o.status !== "cancelled")
    .reduce((sum, o) => sum + o.subtotal_cents, 0);
  return {
    id: b.id,
    table_id: b.table_id,
    table_label: s.tables.find((t) => t.id === b.table_id)!.label,
    status: b.status,
    opened_at: b.opened_at,
    paid_at: null,
    ...counts,
    service_charge_bp: store.service_charge_bp,
    sst_bp: store.sst_bp,
    ...calculateAmounts(subtotal, store.service_charge_bp, store.sst_bp),
  };
}
function orders(s: State, store: Store, b: InternalBill): LiveOrder[] {
  return b.orders.map((o) => ({
    id: o.id,
    store_id: store.id,
    table_id: b.table_id,
    bill_id: b.id,
    seq_in_bill: o.seq_in_bill,
    device_seq_in_bill: o.device_seq_in_bill,
    status: o.status,
    subtotal_cents: o.subtotal_cents,
    item_count: o.item_count,
    created_at: o.created_at,
    updated_at: o.created_at,
    accepted_at: null,
    served_at: null,
    cancelled_at: null,
    cancel_reason: o.cancel_reason,
    cancel_note: o.cancel_note,
    order_items: o.lines,
    dining_tables: { label: s.tables.find((t) => t.id === b.table_id)!.label },
  }));
}
// M11: fixed 20 rows; M12: explicit public fields, never device hashes.
export async function listStoreBills(
  status: "open" | "paid",
  page = 1,
  filters: StoreBillFilters = {},
): Promise<BillPage> {
  const { s, store, m } = await context();
  if (!Number.isInteger(page) || page < 1 || !["open", "paid"].includes(status))
    fail("VALIDATION_FAILED", "分页参数不正确");
  if (
    filters.paid_date &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(filters.paid_date) ||
      !Number.isFinite(Date.parse(`${filters.paid_date}T00:00:00+08:00`)) ||
      day(`${filters.paid_date}T00:00:00+08:00`) !== filters.paid_date)
  )
    fail("VALIDATION_FAILED", "请选择有效付款日期", { field: "paid_date" });
  const rows = s.bills
    .filter(
      (b) =>
        b.status === status &&
        s.tables.some((t) => t.id === b.table_id && t.store_id === store.id),
    )
    .map((b) => overview(s, store, m, b))
    .filter(
      (b) =>
        (!filters.table_id || b.table_id === filters.table_id) &&
        (!filters.paid_date ||
          (!!b.paid_at && day(b.paid_at) === filters.paid_date)),
    )
    .sort(
      (a, b) =>
        a.table_label.localeCompare(b.table_label, "zh", { numeric: true }) ||
        a.id.localeCompare(b.id),
    );
  return {
    bills: rows.slice((page - 1) * 20, page * 20),
    total: rows.length,
    page,
    page_size: 20,
  };
}
export async function getStoreBill(id: string): Promise<StoreBillDetail> {
  const { s, store, m } = await context();
  const b = bill(s, store.id, id);
  return { ...overview(s, store, m, b), orders: orders(s, store, b) };
}
// R2: compare current total, freeze amounts and revoke all bill tokens.
export async function markBillPaid(id: string, expected_total_cents: number) {
  const { s, store, m } = await context(true);
  const b = bill(s, store.id, id);
  if (!Number.isInteger(expected_total_cents) || expected_total_cents < 0)
    fail("VALIDATION_FAILED", "确认金额不正确");
  if (b.status === "paid") fail("BILL_ALREADY_PAID", "这张账单已结账", {}, 409);
  const current = overview(s, store, m, b);
  if (current.total_cents !== expected_total_cents)
    fail(
      "BILL_TOTAL_CHANGED",
      "账单金额已变化，请重新核对后结账",
      current,
      409,
    );
  b.status = "paid";
  const paid = {
    ...current,
    status: "paid" as const,
    paid_at: new Date().toISOString(),
  };
  m.paid[id] = paid;
  let tokens_revoked = 0;
  s.tokens
    .filter((t) => t.bill_id === id)
    .forEach((t) => {
      t.reason = "bill_paid";
      tokens_revoked++;
    });
  persist(s, m);
  return { ...paid, tokens_revoked };
}
// M7 / R7 / R12
export async function listStoreTables(): Promise<DiningTable[]> {
  const { s, store, m } = await context();
  return s.tables
    .filter((t) => t.store_id === store.id && !m.deleted[t.id])
    .map((t, i) => ({
      id: t.id,
      label: t.label,
      is_active: t.active,
      qr_version: t.rotations + 1,
      sort_order: i,
    }));
}
function labelValid(
  s: State,
  m: MetaD,
  store: string,
  label: string,
  except?: string,
) {
  // 最终以后端校验为准；lower(label) unique among non-deleted rows.
  if (!label.trim() || label.trim().length > 20)
    fail("VALIDATION_FAILED", "桌号需填写 1–20 字", { field: "label" });
  if (
    s.tables.some(
      (t) =>
        t.store_id === store &&
        !m.deleted[t.id] &&
        t.id !== except &&
        t.label.toLowerCase() === label.trim().toLowerCase(),
    )
  )
    fail("TABLE_LABEL_TAKEN", "这个桌号已存在", {}, 409);
}
export async function createStoreTable(label: string) {
  const { s, store, m } = await context(true);
  labelValid(s, m, store.id, label);
  const id = crypto.randomUUID(),
    code = `mock-${crypto.randomUUID()}`;
  s.tables.push({
    id,
    label: label.trim(),
    store_id: store.id,
    code,
    original_code: code,
    rotations: 0,
    active: true,
  });
  persist(s, m);
  return id;
}
export async function renameStoreTable(id: string, label: string) {
  const { s, store, m } = await context(true);
  const t = table(s, m, store.id, id);
  labelValid(s, m, store.id, label, id);
  t.label = label.trim();
  persist(s, m);
}
export async function softDeleteStoreTable(id: string) {
  const { s, store, m } = await context(true);
  const t = table(s, m, store.id, id);
  if (s.bills.some((b) => b.table_id === id && b.status === "open"))
    fail("TABLE_HAS_OPEN_BILL", "这桌还有未结账单，请先结账", {}, 409);
  m.deleted[id] = new Date().toISOString();
  t.active = false;
  persist(s, m);
}
export async function rotateStoreTableQr(id: string) {
  const { s, store, m } = await context(true);
  const t = table(s, m, store.id, id);
  t.rotations++;
  t.code = `${t.original_code}-r${t.rotations}`;
  let tokens_revoked = 0;
  s.tokens
    .filter((x) => x.table_id === id && !x.reason)
    .forEach((x) => {
      x.reason = "qr_rotated";
      tokens_revoked++;
    });
  persist(s, m);
  return { table_id: id, qr_version: t.rotations + 1, tokens_revoked };
}
// S1-shaped mock links only; never invokes the signing server action.
export async function getStoreTableQrLinks(
  ids: string[],
): Promise<TableQrLink[]> {
  const { s, store, m } = await context();
  return ids.map((id) => {
    const t = table(s, m, store.id, id);
    return {
      table_id: id,
      label: t.label,
      url: `/t/${encodeURIComponent(t.code)}`,
    };
  });
}
export async function getStoreProfile(): Promise<Store> {
  return (await context()).store;
}
export async function saveStoreProfile(
  patch: StoreProfilePatch,
): Promise<Store> {
  const { s, store, m } = await context(true);
  const allowed = [
    "name",
    "logo_path",
    "address",
    "opening_hours",
    "is_accepting_orders",
    "service_charge_bp",
    "sst_bp",
  ];
  for (const field of Object.keys(patch))
    if (!allowed.includes(field))
      fail("VALIDATION_FAILED", "不能修改这个字段", { field });
  const next = { ...store, ...patch };
  for (const [field, max] of [
    ["name", 50],
    ["address", 200],
    ["opening_hours", 200],
  ] as const) {
    if (
      typeof next[field] !== "string" ||
      next[field].trim().length > max ||
      (field === "name" && !next[field].trim())
    )
      fail(
        "VALIDATION_FAILED",
        `${field === "name" ? "店名" : "内容"}格式不正确（最多 ${max} 字）`,
        { field },
      );
    next[field] = next[field].trim();
  }
  for (const [field, max] of [
    ["service_charge_bp", 2000],
    ["sst_bp", 1000],
  ] as const)
    if (!Number.isInteger(next[field]) || next[field] < 0 || next[field] > max)
      fail("VALIDATION_FAILED", `费率超出范围或不是整数基点`, { field });
  if (typeof next.is_accepting_orders !== "boolean")
    fail("VALIDATION_FAILED", "营业状态格式不正确", {
      field: "is_accepting_orders",
    });
  if (
    next.logo_path !== null &&
    (typeof next.logo_path !== "string" ||
      next.logo_path.length > 300 ||
      !/^\/mock\/[\w./-]+$/.test(next.logo_path))
  )
    fail("VALIDATION_FAILED", "假数据图片路径需在 /mock/ 下，最多 300 字", {
      field: "logo_path",
    });
  next.is_profile_complete = !!(
    next.address.trim() && next.opening_hours.trim()
  );
  next.updated_at = new Date().toISOString();
  Object.assign(store, next);
  persist(s, m);
  return next;
}
const day = (iso: string) =>
  new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 10);
export async function getStoreHistory(date: string): Promise<StoreHistory> {
  const { s, store, m } = await context();
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(`${date}T00:00:00+08:00`)) ||
    day(`${date}T00:00:00+08:00`) !== date
  )
    fail("VALIDATION_FAILED", "请选择有效日期", { field: "date" });
  const bills = s.bills.filter((b) =>
    s.tables.some((t) => t.id === b.table_id && t.store_id === store.id),
  );
  const rows = bills
    .flatMap((b) => orders(s, store, b))
    .filter((o) => day(o.created_at) === date)
    .sort(
      (a, b) =>
        b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id),
    );
  const views = bills.map((b) => overview(s, store, m, b));
  const paid = views.filter(
      (b) => b.status === "paid" && b.paid_at && day(b.paid_at) === date,
    ),
    open = views.filter((b) => b.status === "open");
  const sum = (
    list: StoreBillRow[],
    field: keyof ReturnType<typeof calculateAmounts>,
  ) => list.reduce((n, b) => n + b[field], 0);
  return {
    orders: rows,
    stats: {
      date,
      timezone: "Asia/Kuala_Lumpur",
      currency: "MYR",
      revenue_cents: sum(paid, "total_cents"),
      paid_bills: {
        count: paid.length,
        subtotal_cents: sum(paid, "subtotal_cents"),
        service_charge_cents: sum(paid, "service_charge_cents"),
        sst_cents: sum(paid, "sst_cents"),
        rounding_cents: 0,
        total_cents: sum(paid, "total_cents"),
      },
      open_bills: {
        count: open.length,
        subtotal_cents: sum(open, "subtotal_cents"),
        total_cents: sum(open, "total_cents"),
      },
      orders: {
        count: rows.filter((o) => o.status !== "cancelled").length,
        cancelled_count: rows.filter((o) => o.status === "cancelled").length,
      },
    },
  };
}
export async function storeMockActionD(action: StoreMockActionD) {
  const { s, store, m } = await context();
  if (action === "restore") {
    const original = seed();
    s.bills = s.bills.filter(
      (b) =>
        !s.tables.some((t) => t.id === b.table_id && t.store_id === store.id),
    );
    s.bills.push(
      ...original.bills.filter((b) =>
        original.tables.some(
          (t) => t.id === b.table_id && t.store_id === store.id,
        ),
      ),
    );
    m.paid = {};
  }
  if (action === "empty")
    s.bills = s.bills.filter(
      (b) =>
        !s.tables.some((t) => t.id === b.table_id && t.store_id === store.id),
    );
  if (action === "many_bills") {
    const t = s.tables.find(
      (t) => t.store_id === store.id && t.active && !m.deleted[t.id],
    );
    if (t)
      for (let i = 0; i < 45; i++) {
        const id = crypto.randomUUID();
        const b: InternalBill = {
          id,
          table_id: t.id,
          status: "paid",
          opened_at: new Date().toISOString(),
          orders: [],
        };
        s.bills.push(b);
        m.paid[id] = {
          ...overview(s, store, m, b),
          paid_at: new Date().toISOString(),
        };
      }
  }
  persist(s, m);
}

// M7: public field is is_active; the shared mock state stores active internally.
export async function setStoreTableActive(id: string, is_active: boolean) {
  const { s, store, m } = await context(true);
  if (typeof is_active !== "boolean")
    fail("VALIDATION_FAILED", "桌子状态不正确");
  table(s, m, store.id, id).active = is_active;
  persist(s, m);
}
