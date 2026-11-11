import { afterEach, beforeEach, expect, it, vi } from "vitest";
const pr4 = await import("../lib/data/mock/bills");
const tables = await import("../lib/data/mock/tables");
const store = await import("../lib/data/mock/store");
const d = await import("../lib/data/mock/store-d");
const { authRead, authSave } = await import("../lib/data/mock/auth-c");
const { readState, tableFor } = await import("../lib/data/mock/state");
const { runMockAction } = await import("../lib/data/mock/controls-a");
import { malaysiaToday } from "../lib/ui/store-d-helpers";
async function finish<T>(p: Promise<T>) {
  const result = p.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await vi.runAllTimersAsync();
  const r = await result;
  if ("error" in r) throw r.error;
  return r.value;
}
beforeEach(() => {
  vi.useFakeTimers();
  const values = new Map<string, string>();
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
  });
  const a = authRead();
  a.identity = "auth-owner";
  authSave(a);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("PR4 checkout, PR-D history and control-panel settlement share frozen snapshots", async () => {
  const b = await finish(d.getStoreBill("bill-a1"));
  await finish(pr4.markBillPaid(b.id, b.total_cents));
  expect((await finish(d.listStoreBills("paid"))).bills[0]).toMatchObject({
    id: b.id,
    total_cents: b.total_cents,
  });
  expect(
    (await finish(d.getStoreHistory(malaysiaToday()))).stats.revenue_cents,
  ).toBe(b.total_cents);
  expect((await finish(pr4.getBillDetail(b.id))).bill.is_estimate).toBe(false);
  await finish(store.updateStore({ service_charge_bp: 0, sst_bp: 0 }));
  expect((await finish(pr4.getBillDetail(b.id))).bill.total_cents).toBe(
    b.total_cents,
  );
});
it("control-panel payments appear through PR4", async () => {
  const b = await finish(d.getStoreBill("bill-a1"));
  await runMockAction("paid", "demo-a1");
  expect(
    (await finish(pr4.listBills({ status: "paid" }))).bills,
  ).toContainEqual(
    expect.objectContaining({ id: b.id, total_cents: b.total_cents }),
  );
});
it("PR-D table activation, rotation and deletion agree with PR4 and customer lookup", async () => {
  const t = (await finish(tables.listTables()))[0];
  const old = readState().tables.find((x) => x.id === t.id)!.code;
  await finish(d.rotateStoreTableQr(t.id));
  expect(
    (await finish(tables.listTables())).find((x) => x.id === t.id)?.qr_version,
  ).toBe(t.qr_version + 1);
  expect(() => tableFor(readState(), old)).toThrow();
  const code = readState().tables.find((x) => x.id === t.id)!.code;
  expect(tableFor(readState(), code).table.id).toBe(t.id);
  await finish(d.setStoreTableActive(t.id, false));
  expect(
    (await finish(tables.listTables())).find((x) => x.id === t.id)?.is_active,
  ).toBe(false);
  expect(() => tableFor(readState(), code)).toThrow();
  const id = await finish(tables.createTable("Z"));
  await finish(d.softDeleteStoreTable(id));
  expect((await finish(tables.listTables())).some((x) => x.id === id)).toBe(
    false,
  );
});
it("profile updates in either API are visible to both APIs and customer state", async () => {
  await finish(
    d.saveStoreProfile({ name: "共享店", is_accepting_orders: false }),
  );
  expect(await finish(store.getStore())).toMatchObject({
    name: "共享店",
    is_accepting_orders: false,
  });
  await finish(store.updateStore({ address: "共享地址" }));
  expect(await finish(d.getStoreProfile())).toMatchObject({
    address: "共享地址",
  });
  expect(tableFor(readState(), "demo-a1").store).toMatchObject({
    name: "共享店",
    address: "共享地址",
    is_accepting_orders: false,
  });
});
