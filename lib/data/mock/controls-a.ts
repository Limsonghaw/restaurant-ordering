import type { MockAction, MockSettings, MockSnapshot } from "../types";
import { seed } from "./seed";
import { readState, saveState, stateKey } from "./state";
export async function getMockSnapshot(): Promise<MockSnapshot> {
  const state = readState();
  return {
    settings: state.settings,
    demo_codes: state.tables.map((t) => t.code),
    identity: `店 A · 店家（${state.stores[0].status === "suspended" ? "已停用" : "正常"}假数据身份）· 模拟手机 #${state.device_counter ?? 1}`,
  };
}
export async function configureMock(settings: Partial<MockSettings>) {
  const state = readState();
  Object.assign(state.settings, settings);
  saveState(state);
}
export async function runMockAction(action: MockAction, code: string) {
  const state = readState();
  const table = state.tables.find(
    (t) => t.code === code || t.original_code === code,
  );
  if (action === "reset") {
    for (const key of Object.keys(localStorage))
      if (key.startsWith("cart:") || key.startsWith("ro-mock:"))
        localStorage.removeItem(key);
    localStorage.setItem(stateKey, JSON.stringify(seed()));
  } else {
    if (action === "switch_device") {
      state.device_id = crypto.randomUUID();
      state.device_counter = (state.device_counter ?? 1) + 1;
    }
    if (action === "suspend")
      state.stores[0].status =
        state.stores[0].status === "active" ? "suspended" : "active";
    if (table) {
      const bill = state.bills.find(
        (b) => b.table_id === table.id && b.status === "open",
      );
      if (action === "paid" && bill) {
        bill.status = "paid";
        state.tokens
          .filter((t) => t.bill_id === bill.id)
          .forEach((t) => {
            t.reason = "bill_paid";
          });
      }
      if (action === "rotate") {
        table.rotations++;
        table.code = `${table.original_code}-r${table.rotations}`;
        state.tokens
          .filter((t) => t.table_id === table.id)
          .forEach((t) => {
            t.reason = "qr_rotated";
          });
      }
      if (action === "expire")
        state.tokens
          .filter(
            (t) => t.table_id === table.id && t.device_id === state.device_id,
          )
          .forEach((t) => {
            t.reason = "expired";
          });
    }
    saveState(state);
  }
  window.dispatchEvent(new Event("ro-mock:change"));
}
