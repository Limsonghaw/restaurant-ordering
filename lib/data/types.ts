// 字段对齐阶段 1 后端设计文档（更新 7、更新 8），后端改动时同步；只追加、不改名。
export type StoreStatus = "active" | "suspended" | "pending_review";
export interface MyStoreSummary {
  id: string;
  slug: string;
  name: string;
  logo_path: string | null;
  status: StoreStatus;
  status_changed_at: string | null;
  is_accepting_orders: boolean;
  is_profile_complete: boolean;
}
export interface MyContext {
  user_id: string;
  platform_role: "merchant" | "platform_admin" | null;
  aal: "aal1" | "aal2";
  password_set: boolean;
  password_set_at: string | null;
  member_role: "owner" | "staff" | null;
  store: MyStoreSummary | null;
}
export interface BlockedClientRow {
  id: string;
  kind: "device" | "ip";
  reason: string;
  created_at: string;
  expires_at: string;
  is_active: boolean;
  source_order: {
    id: string;
    seq_in_bill: number;
    table_label: string;
    subtotal_cents: number;
    created_at: string;
  } | null;
}
export type BillGoneReason = "bill_paid" | "qr_rotated" | "expired";
export interface QuoteEstimate {
  estimate_basis: "this_order";
  service_charge_bp: number;
  sst_bp: number;
  estimated_service_charge_cents: number | null;
  estimated_sst_cents: number | null;
  estimated_rounding_cents: number | null;
  estimated_total_cents: number | null;
}
export type ErrorCode =
  | "TABLE_INVALID"
  | "STORE_SUSPENDED"
  | "RATE_LIMITED"
  | "NETWORK"
  | "NOT_IMPLEMENTED"
  | "PRICE_CHANGED"
  | "ITEM_UNAVAILABLE"
  | "STORE_CLOSED"
  | "ORDER_LIMIT_EXCEEDED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "DEVICE_BLOCKED"
  | "CAPTCHA_REQUIRED"
  | "CAPTCHA_FAILED"
  | "BILL_TOKEN_EXPIRED"
  | "BILL_TOKEN_INVALID"
  | "MFA_REQUIRED"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "CATEGORY_NOT_EMPTY"
  | "PHONE_NOT_SUPPORTED"
  | "SMS_SEND_FAILED"
  | "RESET_LINK_INVALID"
  | "OTP_INVALID"
  | "REAUTH_REQUIRED"
  | "WEAK_PASSWORD"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "INVALID_CREDENTIALS"
  | "EMAIL_NOT_CONFIRMED"
  | "PHONE_NOT_CONFIRMED"
  | "UNSUPPORTED_FILE_TYPE"
  | "FILE_TOO_LARGE"
  | "UPLOAD_FAILED"
  | "ORDER_STATUS_CONFLICT"
  | "INVALID_STATUS_TRANSITION"
  | "ORDER_BILL_CLOSED";
export class DataError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details: Record<string, unknown> = {},
    public status = 400,
    public retryAfterSeconds = 0,
  ) {
    super(message);
    this.name = "DataError";
  }
}
export interface Store extends MyStoreSummary {
  address: string;
  opening_hours: string;
  currency: "MYR";
  locale: string;
  timezone: string;
  service_charge_bp: number;
  sst_bp: number;
  cash_rounding: boolean;
  require_first_order_approval: boolean;
  max_order_cents: number;
  require_captcha: boolean;
  created_at: string;
  updated_at: string;
}
export interface Category {
  id: string;
  name: string;
  sort_order: number;
}
export interface MenuItem {
  id: string;
  category_id: string;
  name: string;
  description: string;
  price_cents: number;
  image_path: string | null;
  thumb_path: string | null;
  is_sold_out: boolean;
  sort_order: number;
}
export interface TableMenu {
  store: Pick<
    Store,
    | "id"
    | "name"
    | "logo_path"
    | "address"
    | "opening_hours"
    | "is_accepting_orders"
    | "currency"
    | "service_charge_bp"
    | "sst_bp"
  >;
  table: { id: string; label: string };
  categories: Category[];
  items: MenuItem[];
  table_in_use: boolean;
}
export interface CartItem {
  item_id: string;
  quantity: number;
  unit_price_cents: number;
  note: string;
}
export interface OrderLine {
  item_name: string;
  unit_price_cents: number;
  quantity: number;
  line_total_cents: number;
  note: string;
}
export interface QuoteLine extends OrderLine {
  line_no: number;
  item_id: string;
}
export interface Unavailable {
  item_id: string;
  reason: "sold_out" | "unavailable";
  name: string;
}
export interface PriceChange {
  item_id: string;
  name: string;
  client_unit_price_cents: number;
  current_unit_price_cents: number;
}
export interface CartQuote extends QuoteEstimate {
  can_order: boolean;
  is_accepting_orders: boolean;
  limit_exceeded: boolean;
  lines: QuoteLine[];
  item_count: number;
  subtotal_cents: number;
  unavailable: Unavailable[];
  price_changes: PriceChange[];
  max_order_cents: number;
}
export type OrderStatus = "new" | "accepted" | "served" | "cancelled";
export type CancelReason =
  "sold_out" | "customer_request" | "duplicate" | "other";
export interface Order {
  id: string;
  seq_in_bill: number;
  status: OrderStatus;
  subtotal_cents: number;
  item_count: number;
  created_at: string;
  cancel_reason: CancelReason | null;
  lines: OrderLine[];
}
export interface PlaceOrderBody {
  client_request_id: string;
  items: CartItem[];
  captcha_token?: string;
}
export interface PlaceOrderResult {
  replayed: boolean;
  bill_token_issued: boolean;
  order: Order;
  bill: { id: string; status: "open" | "paid" };
}
export interface BillAmounts {
  subtotal_cents: number;
  service_charge_cents: number;
  sst_cents: number;
  rounding_cents: number;
  total_cents: number;
}
export type TableBill =
  | {
      view: "table";
      table_in_use: boolean;
      bill: null;
      orders: [];
      poll_after_ms: null;
    }
  | {
      view: "bill";
      scope: "own_orders";
      store: { name: string; is_accepting_orders: boolean };
      table: { label: string };
      bill: BillAmounts & {
        id: string;
        status: "open" | "paid";
        opened_at: string;
        paid_at: string | null;
        currency: "MYR";
        token_expires_at: string;
        amounts_basis: "own_orders";
        is_estimate: true;
      };
      orders: Order[];
      poll_after_ms: number;
    };
export type Session = MyContext & {
  user: { id: string; email: string | null; phone: string | null };
};
export interface MockSettings {
  slow: boolean;
  fail_next: boolean;
  next_order: string;
  captcha_fail: boolean;
  auto_progress: boolean;
}
export interface MockSnapshot {
  settings: MockSettings;
  demo_codes: string[];
  identity: string;
}
export type MockAction =
  "paid" | "rotate" | "expire" | "switch_device" | "reset" | "suspend";

export type AuthContact =
  { email: string; phone?: never } | { phone: string; email?: never };
export interface AuthMail {
  id: string;
  recipient: string;
  type: string;
  created_at: string;
  expires_at: number;
  used: boolean;
  next: string;
}
export interface ManagedCategory extends Category {
  is_hidden: boolean;
  itemCount: number;
}
export interface ManagedItem extends MenuItem {
  is_hidden: boolean;
  deleted_at?: string | null;
}
export type ItemInput = Omit<ManagedItem, "id" | "sort_order" | "deleted_at">;
export interface StoreMenu {
  categories: ManagedCategory[];
  items: ManagedItem[];
}
export interface AuthMockSnapshot {
  aal: "aal1" | "aal2";
  identity: string | null;
  mails: AuthMail[];
}
// PR-B：M9 / R1 / M10 店家接单合约，只追加。
export interface LiveOrder {
  id: string;
  store_id: string;
  table_id: string;
  bill_id: string;
  seq_in_bill: number;
  device_seq_in_bill: number;
  status: OrderStatus;
  subtotal_cents: number;
  item_count: number;
  created_at: string;
  accepted_at: string | null;
  served_at: string | null;
  cancelled_at: string | null;
  updated_at: string;
  cancel_reason: CancelReason | null;
  cancel_note: string | null;
  order_items: OrderLine[];
  dining_tables: { label: string };
}
export interface OrderStatusChange {
  to: OrderStatus;
  expected: OrderStatus;
  cancel_reason?: CancelReason;
  cancel_note?: string;
}
export type LiveStoreStatus = Pick<
  Store,
  "name" | "status" | "is_accepting_orders"
>;
export type OrderConnection = "connected" | "reconnecting" | "disconnected";
export interface StoreOrderCallbacks {
  onInsert: (order: LiveOrder) => void;
  onUpdate: (order: LiveOrder) => void;
  onConnectionChange: (status: OrderConnection) => void;
}
export interface LiveMockSettings {
  disconnected: boolean;
  hold: boolean;
  expired: boolean;
  fail_status: boolean;
  no_wake: boolean;
  sound_paused: boolean;
  threshold_ms: number;
}
export type LiveMockAction =
  | "new"
  | "three"
  | "missed"
  | "disconnect"
  | "reconnect"
  | "other"
  | "other_silent"
  | "paid";

// PR2 merchant database additions (append only).
export type MerchantErrorCode =
  | "UNAUTHENTICATED" | "FORBIDDEN" | "NOT_FOUND" | "STORE_SUSPENDED"
  | "VALIDATION_FAILED" | "CATEGORY_NOT_EMPTY" | "TABLE_LABEL_TAKEN"
  | "TABLE_HAS_OPEN_BILL" | "CONFLICT" | "INTERNAL" | "ORDER_BILL_CLOSED"
  | "FILE_TOO_LARGE" | "UNSUPPORTED_FILE_TYPE" | "UPLOAD_FAILED";
export interface DiningTable {
  id: string;
  label: string;
  is_active: boolean;
  qr_version: number;
  sort_order: number;
}
export type StoreProfilePatch = Partial<Pick<Store,
  "name" | "logo_path" | "address" | "opening_hours" | "is_accepting_orders" | "service_charge_bp" | "sst_bp"
>>;

export type Pr4ErrorCode =
  | "ORDER_STATUS_CONFLICT"
  | "INVALID_STATUS_TRANSITION"
  | "BILL_TOTAL_CHANGED"
  | "BILL_ALREADY_PAID";
export interface BillListRow extends BillAmounts {
  id: string;
  store_id: string;
  table_id: string;
  table_label: string;
  status: "open" | "paid";
  opened_at: string;
  paid_at: string | null;
  updated_at: string;
  service_charge_bp: number;
  sst_bp: number;
  is_estimate: boolean;
  order_count: number;
  unserved_count: number;
  currency: "MYR";
}
export interface BillFilters {
  page?: number;
  status?: "open" | "paid";
  table_id?: string;
  paid_from?: string;
  paid_to?: string;
}
export interface BillPage {
  bills: BillListRow[];
  total: number;
  page: number;
  page_size: 20;
}
export interface BillDetail {
  bill: BillListRow;
  orders: LiveOrder[];
}
export interface CheckoutResult extends BillAmounts {
  id: string;
  status: "paid";
  paid_at: string;
  table_id: string;
  tokens_revoked: number;
}
export interface PlaceOrderBody {
  turnstile_token?: string;
}

// New merchant errors remain append-only alongside the original ErrorCode union.
export type DataErrorCode = ErrorCode | MerchantErrorCode | Pr4ErrorCode;
export interface CheckoutResult { service_charge_bp: number; sst_bp: number; is_estimate: false }
