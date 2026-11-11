import { beforeEach, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({
  listBills: vi.fn(),
  getBillDetail: vi.fn(),
  listTables: vi.fn(),
  createTable: vi.fn(),
  updateTable: vi.fn(),
  deleteTable: vi.fn(),
  rotateTableQr: vi.fn(),
  getStore: vi.fn(),
  updateStore: vi.fn(),
}));
vi.mock("../lib/data/bills", () => api);
vi.mock("../lib/data/tables", () => api);
vi.mock("../lib/data/store", () => api);
vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", "supabase");
const d = await import("../lib/data/d");
beforeEach(() => vi.resetAllMocks());
it("maps status, page, table and one payment day to inclusive PR4 date filters", async () => {
  api.listBills.mockResolvedValue({
    bills: [{ id: "b", status: "open" }],
    page: 2,
    total: 21,
    page_size: 20,
  });
  const result = await d.listStoreBills("paid", 2, {
    table_id: "t",
    paid_date: "2026-11-11",
  });
  expect(api.listBills).toHaveBeenCalledWith({
    status: "paid",
    page: 2,
    table_id: "t",
    paid_from: "2026-11-11",
    paid_to: "2026-11-11",
  });
  expect(result.bills[0]).toMatchObject({ is_estimate: true });
  expect(result.bills[0].order_count).toBeUndefined();
  expect(result.bills[0].unserved_count).toBeUndefined();
});
it("flattens bill detail and derives missing counts without changing money", async () => {
  const orders = [
    { status: "new" },
    { status: "accepted" },
    { status: "cancelled" },
  ];
  api.getBillDetail.mockResolvedValue({
    bill: { id: "b", status: "open", total_cents: 321 },
    orders,
  });
  expect(await d.getStoreBill("b")).toEqual({
    id: "b",
    status: "open",
    total_cents: 321,
    orders,
    order_count: 3,
    unserved_count: 2,
    is_estimate: true,
  });
  expect(api.getBillDetail).toHaveBeenCalledWith("b");
});
it("preserves supplied detail metadata", async () => {
  api.getBillDetail.mockResolvedValue({
    bill: {
      status: "paid",
      order_count: 9,
      unserved_count: 0,
      is_estimate: false,
    },
    orders: [],
  });
  expect(await d.getStoreBill("b")).toMatchObject({
    order_count: 9,
    unserved_count: 0,
    is_estimate: false,
  });
});
it("maps all table reads and writes", async () => {
  api.listTables.mockResolvedValue([{ id: "t" }]);
  api.createTable.mockResolvedValue("t");
  api.rotateTableQr.mockResolvedValue({ qr_version: 2 });
  expect(await d.listStoreTables()).toEqual([{ id: "t" }]);
  expect(await d.createStoreTable("A")).toBe("t");
  await d.renameStoreTable("t", "B");
  await d.setStoreTableActive("t", false);
  await d.softDeleteStoreTable("t");
  expect(await d.rotateStoreTableQr("t")).toEqual({ qr_version: 2 });
  expect(api.createTable).toHaveBeenCalledWith("A");
  expect(api.updateTable.mock.calls).toEqual([
    ["t", { label: "B" }],
    ["t", { is_active: false }],
  ]);
  expect(api.deleteTable).toHaveBeenCalledWith("t");
  expect(api.rotateTableQr).toHaveBeenCalledWith("t");
});
it("reads profile and reads authoritative result after a partial patch", async () => {
  api.getStore.mockResolvedValue({ name: "store" });
  expect(await d.getStoreProfile()).toEqual({ name: "store" });
  expect(await d.saveStoreProfile({ is_accepting_orders: false })).toEqual({
    name: "store",
  });
  expect(api.updateStore).toHaveBeenCalledWith({ is_accepting_orders: false });
  expect(api.updateStore.mock.invocationCallOrder[0]).toBeLessThan(
    api.getStore.mock.invocationCallOrder[1],
  );
});
it.each([
  ["listBills", () => d.listStoreBills("open")],
  ["getBillDetail", () => d.getStoreBill("b")],
  ["listTables", () => d.listStoreTables()],
  ["createTable", () => d.createStoreTable("A")],
  ["updateTable", () => d.renameStoreTable("t", "B")],
  ["updateTable", () => d.setStoreTableActive("t", false)],
  ["deleteTable", () => d.softDeleteStoreTable("t")],
  ["rotateTableQr", () => d.rotateStoreTableQr("t")],
  ["getStore", () => d.getStoreProfile()],
  ["updateStore", () => d.saveStoreProfile({ name: "A" })],
] as const)("passes %s errors through unchanged", async (name, call) => {
  const error = { code: "STORE_SUSPENDED", details: {} };
  api[name].mockRejectedValue(error);
  await expect(call()).rejects.toBe(error);
});
it("keeps history and QR signing unavailable", async () => {
  await expect(d.getStoreHistory("2026-11-11")).rejects.toMatchObject({
    code: "NOT_IMPLEMENTED",
  });
  await expect(d.getStoreTableQrLinks(["t"])).rejects.toMatchObject({
    code: "NOT_IMPLEMENTED",
  });
});
