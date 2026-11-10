import { DataError } from "../types";
import { seed, type State } from "./seed";
export const stateKey = "ro-mock:state-v2";
export function readState(): State {
  if (typeof window === "undefined")
    throw new DataError("NETWORK", "假数据仅在浏览器中运行");
  const raw = localStorage.getItem(stateKey);
  if (raw) {
    try {
      return JSON.parse(raw) as State;
    } catch {
      /* 损坏的数据重新初始化 */
    }
  }
  const value = seed();
  saveState(value);
  return value;
}
export function saveState(state: State) {
  localStorage.setItem(stateKey, JSON.stringify(state));
}
export async function delay() {
  const state = readState();
  await new Promise((resolve) =>
    setTimeout(resolve, state.settings.slow ? 3000 : 200 + Math.random() * 300),
  );
  const current = readState();
  if (current.settings.fail_next) {
    current.settings.fail_next = false;
    saveState(current);
    throw new DataError("NETWORK", "网络出错，请检查网络后重试", {}, 503);
  }
}
export function tableFor(state: State, code: string) {
  const table = state.tables.find((t) => t.code === code && t.active);
  if (!table)
    throw new DataError(
      "TABLE_INVALID",
      "这个二维码已失效，请联系店员",
      {},
      404,
    );
  const store = state.stores.find((s) => s.id === table.store_id)!;
  if (store.status === "suspended")
    throw new DataError("STORE_SUSPENDED", "本店暂停服务", {}, 403);
  return { table, store };
}
