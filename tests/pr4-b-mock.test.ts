import { beforeEach, afterEach, expect, it, vi } from "vitest";
const { authRead, authSave } = await import("../lib/data/mock/auth-c");
const { getStore, updateStore } = await import("../lib/data/mock/store");
const tables = await import("../lib/data/mock/tables");
const bills = await import("../lib/data/mock/bills");
const { readState, saveState } = await import("../lib/data/mock/state");
const { allLiveOrders } = await import("../lib/data/mock/live-state");
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  const auth = authRead();
  auth.identity = "auth-owner";
  authSave(auth);
});
afterEach(() => vi.unstubAllGlobals());
it("store and table facade implementations roundtrip owned records and rotate QR", async () => {
  const store = await getStore();
  await updateStore({ name: "新店名" });
  expect((await getStore()).name).toBe("新店名");
  const id = await tables.createTable("Z1");
  await tables.updateTable(id, {
    label: "Z2",
    is_active: false,
    sort_order: 0,
  });
  expect((await tables.listTables()).find((t) => t.id === id)).toMatchObject({
    label: "Z2",
    is_active: false,
  });
  expect(await tables.rotateTableQr(id)).toMatchObject({
    table_id: id,
    qr_version: 2,
  });
  await tables.deleteTable(id);
  expect((await tables.listTables()).some((t) => t.id === id)).toBe(false);
  expect((await getStore()).id).toBe(store.id);
});
it("mock bill amounts exclude cancelled orders and payment freezes totals and revokes tokens", async () => {
  allLiveOrders((await getStore()).id);
  const page = await bills.listBills();
  expect(page.page_size).toBe(20);
  const bill = page.bills.find((b) => b.status === "open")!;
  const detail = await bills.getBillDetail(bill.id);
  expect(
    detail.orders.every((o) => Number.isInteger(o.device_seq_in_bill)),
  ).toBe(true);
  expect(JSON.stringify(detail)).not.toContain("device_id");
  await expect(
    bills.markBillPaid(bill.id, bill.total_cents + 1),
  ).rejects.toMatchObject({
    code: "BILL_TOTAL_CHANGED",
    details: { total_cents: bill.total_cents },
  });
  const state = readState();
  state.tokens.push({
    table_id: bill.table_id,
    bill_id: bill.id,
    device_id: "test-device",
    token: "test-only",
    expires_at: Date.now() + 10000,
  });
  saveState(state);
  const paid = await bills.markBillPaid(bill.id, bill.total_cents);
  expect(paid.tokens_revoked).toBeGreaterThanOrEqual(1);
  expect(readState().tokens.find((t) => t.token === "test-only")?.reason).toBe(
    "bill_paid",
  );
  await updateStore({ service_charge_bp: 0, sst_bp: 0 });
  expect((await bills.getBillDetail(bill.id)).bill).toMatchObject({
    total_cents: paid.total_cents,
    is_estimate: false,
    status: "paid",
  });
  await expect(
    bills.markBillPaid(bill.id, paid.total_cents),
  ).rejects.toMatchObject({ code: "BILL_ALREADY_PAID" });
  expect(
    (
      await bills.listBills({ status: "paid", table_id: bill.table_id })
    ).bills.some((b) => b.id === bill.id),
  ).toBe(true);
});
