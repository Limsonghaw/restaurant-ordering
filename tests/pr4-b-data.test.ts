import { beforeEach, afterEach, expect, it, vi } from "vitest";
const fake = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  setAuth: vi.fn(),
  channel: vi.fn(),
  removeChannel: vi.fn(),
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ ...fake, realtime: { setAuth: fake.setAuth } }),
}));
import * as live from "../lib/data/supabase/live-orders";
import * as bills from "../lib/data/supabase/bills";
import { mapPgError } from "../lib/data/supabase/pg-errors";
function query(data: unknown, count = 0) {
  const q: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const k of [
    "select",
    "returns",
    "eq",
    "in",
    "gt",
    "gte",
    "lt",
    "order",
    "range",
    "update",
    "maybeSingle",
  ])
    q[k] = vi.fn(() => q);
  q.then = vi.fn((resolve) =>
    Promise.resolve(resolve({ data, error: null, count })),
  );
  return q;
}
beforeEach(() => {
  vi.clearAllMocks();
  fake.rpc.mockResolvedValue({
    data: { store: { id: "s", status: "active" } },
    error: null,
  });
  fake.setAuth.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
});
it("queries active statuses with explicit columns and store scope; delta includes terminal states", async () => {
  const q = query([]);
  fake.from.mockReturnValue(q);
  await live.listLiveOrders();
  expect(q.in).toHaveBeenCalledWith("status", ["new", "accepted"]);
  expect(q.eq).toHaveBeenCalledWith("store_id", "s");
  await live.fetchOrdersUpdatedSince("since");
  expect(q.gt).toHaveBeenCalledWith("updated_at", "since");
  expect(q.select).toHaveBeenCalledWith(live.ORDER_COLUMNS);
  expect(live.ORDER_COLUMNS).not.toContain("*");
  expect(live.ORDER_COLUMNS).not.toContain("hash");
});
it("uses half-open Malaysia served day and descending served_at", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T16:01:00Z"));
  const q = query([]);
  fake.from.mockReturnValue(q);
  await live.listServedToday();
  expect(q.gte).toHaveBeenCalledWith("served_at", "2026-11-11T16:00:00.000Z");
  expect(q.lt).toHaveBeenCalledWith("served_at", "2026-11-12T16:00:00.000Z");
  expect(q.order).toHaveBeenCalledWith("served_at", { ascending: false });
});
it("returns narrow store status and writes only accepting flag", async () => {
  const row = { name: "店", status: "active", is_accepting_orders: true },
    q = query(row);
  fake.from.mockReturnValue(q);
  expect(await live.getStoreStatus()).toEqual(row);
  expect(q.select).toHaveBeenCalledWith("name, status, is_accepting_orders");
  expect(await live.setAcceptingOrders(false)).toEqual(row);
  expect(q.update).toHaveBeenCalledWith({ is_accepting_orders: false });
  fake.rpc.mockResolvedValue({
    data: { store: { id: "s", status: "suspended" } },
    error: null,
  });
  await expect(live.setAcceptingOrders(true)).rejects.toMatchObject({
    code: "STORE_SUSPENDED",
  });
});
it("validates cancellation then invokes R1 and reloads full order", async () => {
  await expect(
    live.updateOrderStatus("o", { to: "cancelled", expected: "new" }),
  ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  await expect(
    live.updateOrderStatus("o", {
      to: "cancelled",
      expected: "new",
      cancel_reason: "other",
      cancel_note: "字".repeat(101),
    }),
  ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  const q = query({ id: "o", device_seq_in_bill: 2 });
  fake.from.mockReturnValue(q);
  expect(
    await live.updateOrderStatus("o", {
      to: "cancelled",
      expected: "new",
      cancel_reason: "other",
      cancel_note: "字".repeat(100),
    }),
  ).toMatchObject({ device_seq_in_bill: 2 });
  expect(fake.rpc).toHaveBeenCalledWith(
    "update_order_status",
    expect.objectContaining({
      p_order_id: "o",
      p_expected: "new",
      p_cancel_reason: "other",
    }),
  );
});
it.each([
  "ORDER_STATUS_CONFLICT",
  "INVALID_STATUS_TRANSITION",
  "BILL_TOTAL_CHANGED",
  "BILL_ALREADY_PAID",
])("maps %s as conflict with safe details", (code) => {
  expect(
    mapPgError({
      code: "P0001",
      message: code,
      details: JSON.stringify({
        current_status: "served",
        total_cents: 120,
        secret: "hidden",
      }),
    }),
  ).toMatchObject({
    code,
    status: 409,
    details: { current_status: "served", total_cents: 120 },
  });
  expect(
    mapPgError({ code: "P0001", message: code, details: "not json" }).details,
  ).toEqual({});
});
it("lists 20 bills per page with paid UTC+8 date filters and exact count", async () => {
  const q = query([{ id: "b", is_estimate: true }], 42);
  fake.from.mockReturnValue(q);
  expect(
    await bills.listBills({
      page: 2,
      status: "paid",
      table_id: "t",
      paid_from: "2026-11-10",
      paid_to: "2026-11-11",
    }),
  ).toMatchObject({ total: 42, page: 2, page_size: 20 });
  expect(q.range).toHaveBeenCalledWith(20, 39);
  expect(q.gte).toHaveBeenCalledWith("paid_at", "2026-11-09T16:00:00.000Z");
  expect(q.lt).toHaveBeenCalledWith("paid_at", "2026-11-11T16:00:00.000Z");
  expect(q.select).toHaveBeenCalledWith(bills.BILL_COLUMNS, { count: "exact" });
  await expect(bills.listBills({ page: 0 })).rejects.toMatchObject({
    code: "VALIDATION_FAILED",
  });
  expect(() => bills.paidDateBoundary("2026-02-31")).toThrow();
});
it("loads bill details with device sequence and checks out with expected total", async () => {
  fake.from
    .mockReturnValueOnce(query({ id: "b" }))
    .mockReturnValueOnce(query([{ id: "o", device_seq_in_bill: 3 }]));
  expect(await bills.getBillDetail("b")).toMatchObject({
    orders: [{ device_seq_in_bill: 3 }],
  });
  await bills.markBillPaid("b", 5317);
  expect(fake.rpc).toHaveBeenCalledWith("mark_bill_paid", {
    p_bill_id: "b",
    p_expected_total_cents: 5317,
  });
});
it("authenticates before subscribing to private store channel with orders and bills filters; removes on stop", async () => {
  const channel = { on: vi.fn(), subscribe: vi.fn() };
  channel.on.mockReturnValue(channel);
  channel.subscribe.mockReturnValue(channel);
  fake.channel.mockReturnValue(channel);
  const stop = live.subscribeStoreOrders("s", {
    onInsert: vi.fn(),
    onUpdate: vi.fn(),
    onConnectionChange: vi.fn(),
  });
  await vi.waitFor(() => expect(channel.subscribe).toHaveBeenCalled());
  expect(fake.setAuth).toHaveBeenCalled();
  expect(fake.channel).toHaveBeenCalledWith("store:s", {
    config: { private: true },
  });
  expect(fake.setAuth.mock.invocationCallOrder[0]).toBeLessThan(
    fake.channel.mock.invocationCallOrder[0],
  );
  for (const table of ["orders", "bills"])
    expect(channel.on).toHaveBeenCalledWith(
      "postgres_changes",
      { event: "*", schema: "public", table, filter: "store_id=eq.s" },
      expect.any(Function),
    );
  stop();
  expect(fake.removeChannel).toHaveBeenCalledWith(channel);
});

it("hydrates realtime order events instead of forwarding raw payload; suppresses late callbacks", async () => {
  const channel = { on: vi.fn(), subscribe: vi.fn() };
  channel.on.mockReturnValue(channel);
  fake.channel.mockReturnValue(channel);
  const q = query([{ id: "o", device_seq_in_bill: 4 }]);
  fake.from.mockReturnValue(q);
  const callbacks = {
    onInsert: vi.fn(),
    onUpdate: vi.fn(),
    onConnectionChange: vi.fn(),
  };
  const stop = live.subscribeStoreOrders("s", callbacks);
  await vi.waitFor(() => expect(channel.subscribe).toHaveBeenCalled());
  const onOrder = channel.on.mock.calls[0][2];
  onOrder({ eventType: "INSERT", new: { id: "o" } });
  await vi.waitFor(() =>
    expect(callbacks.onInsert).toHaveBeenCalledWith({
      id: "o",
      device_seq_in_bill: 4,
    }),
  );
  expect(q.eq).toHaveBeenCalledWith("id", "o");
  channel.on.mock.calls[1][2]({ new: { id: "b" } });
  await vi.waitFor(() => expect(callbacks.onUpdate).toHaveBeenCalled());
  stop();
  callbacks.onUpdate.mockClear();
  channel.on.mock.calls[1][2]({ new: { id: "b" } });
  await Promise.resolve();
  await Promise.resolve();
  expect(callbacks.onUpdate).not.toHaveBeenCalled();
});

it("does not create channels after early cleanup or for a different store", async () => {
  const callbacks = {
    onInsert: vi.fn(),
    onUpdate: vi.fn(),
    onConnectionChange: vi.fn(),
  };
  const stop = live.subscribeStoreOrders("s", callbacks);
  stop();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(fake.channel).not.toHaveBeenCalled();
  live.subscribeStoreOrders("other", callbacks);
  await vi.waitFor(() =>
    expect(callbacks.onConnectionChange).toHaveBeenCalledWith("disconnected"),
  );
  expect(fake.channel).not.toHaveBeenCalled();
});
