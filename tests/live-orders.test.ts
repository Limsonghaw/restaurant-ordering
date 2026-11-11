import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataError, type LiveOrder } from "../lib/data/types";
import {
  malaysiaDay,
  reconnectDelay,
  mergeLiveOrders,
  validateOrderChange,
} from "../lib/data/live-rules";
vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", "mock");
const data = await import("../lib/data");
const { authRead, authSave } = await import("../lib/data/mock/auth-c");
function identity(name: string | null) {
  const auth = authRead();
  auth.identity = name ? `auth-${name}` : null;
  authSave(auth);
}
class StorageStub {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}
async function finish<T>(promise: Promise<T>): Promise<T> {
  const guarded = promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await vi.advanceTimersByTimeAsync(600);
  const result = await guarded;
  if ("error" in result) throw result.error;
  return result.value;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T12:00:00+08:00"));
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("localStorage", new StorageStub());
  identity("owner");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("P5 接单合约", () => {
  it("自动重连间隔为 1、2、5、10 秒，其后固定 30 秒", () => {
    expect(Array.from({ length: 7 }, (_, i) => reconnectDelay(i))).toEqual([
      1000, 2000, 5000, 10000, 30000, 30000, 30000,
    ]);
  });
  it("保留 A1 并补足种子、六道以上菜、长备注和超时订单", async () => {
    const live = await finish(data.listLiveOrders());
    expect(live.filter((o) => o.status === "new")).toHaveLength(3);
    expect(live.filter((o) => o.status === "accepted")).toHaveLength(2);
    expect(await finish(data.listServedToday())).toHaveLength(3);
    expect(live.some((o) => o.order_items.length >= 6)).toBe(true);
    expect(
      live.some((o) => Date.now() - Date.parse(o.created_at) > 20 * 60000),
    ).toBe(true);
    expect(
      live.every((o) => o.device_seq_in_bill > 0 && o.dining_tables.label),
    ).toBe(true);
    expect(live.some((o) => "device_id" in o)).toBe(false);
  });
  it("状态只能前进、expected 防冲突、取消原因和备注校验", async () => {
    const order = (await finish(data.listLiveOrders())).find(
      (o) => o.status === "new",
    )!;
    await expect(
      finish(
        data.updateOrderStatus(order.id, { to: "served", expected: "new" }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATUS_TRANSITION" });
    const accepted = await finish(
      data.updateOrderStatus(order.id, { to: "accepted", expected: "new" }),
    );
    expect(accepted.accepted_at).toBeTruthy();
    expect(accepted.updated_at > order.updated_at).toBe(true);
    await expect(
      finish(
        data.updateOrderStatus(order.id, { to: "accepted", expected: "new" }),
      ),
    ).rejects.toMatchObject({
      code: "ORDER_STATUS_CONFLICT",
      details: { current_status: "accepted" },
    });
    await expect(
      finish(
        data.updateOrderStatus(order.id, {
          to: "cancelled",
          expected: "accepted",
        }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(
      finish(
        data.updateOrderStatus(order.id, {
          to: "cancelled",
          expected: "accepted",
          cancel_reason: "other",
          cancel_note: "字".repeat(201),
        }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const cancelled = await finish(
      data.updateOrderStatus(order.id, {
        to: "cancelled",
        expected: "accepted",
        cancel_reason: "sold_out",
        cancel_note: "不会保存",
      }),
    );
    expect(cancelled.cancel_note).toBeNull();
    expect(cancelled.cancelled_at).toBeTruthy();
    expect(
      (await finish(data.listLiveOrders())).some((o) => o.id === order.id),
    ).toBe(false);
    expect(
      (await finish(data.fetchOrdersUpdatedSince(order.updated_at))).find(
        (o) => o.id === order.id,
      )?.status,
    ).toBe("cancelled");
  });
  it("已上菜不可取消、账单付款不可取消", async () => {
    const served = (await finish(data.listServedToday()))[0];
    expect(() =>
      validateOrderChange(
        served,
        { to: "cancelled", expected: "served", cancel_reason: "other" },
        false,
      ),
    ).toThrow(DataError);
    await data.runLiveMockAction("paid");
    const accepted = (await finish(data.listLiveOrders())).find(
      (o) => o.status === "accepted",
    )!;
    await expect(
      finish(
        data.updateOrderStatus(accepted.id, {
          to: "cancelled",
          expected: "accepted",
          cancel_reason: "other",
        }),
      ),
    ).rejects.toMatchObject({ code: "ORDER_BILL_CLOSED" });
  });
  it("断线不推送但订单保存、补拉去重、不推送冲突模拟", async () => {
    const insert = vi.fn();
    const update = vi.fn();
    const connection = vi.fn();
    const initial = await finish(data.listLiveOrders());
    const stop = data.subscribeStoreOrders("store-0", {
      onInsert: insert,
      onUpdate: update,
      onConnectionChange: connection,
    });
    await data.configureLiveMock({ hold: true });
    await data.runLiveMockAction("disconnect");
    await vi.advanceTimersByTimeAsync(500);
    await data.runLiveMockAction("missed");
    await vi.advanceTimersByTimeAsync(500);
    expect(insert).not.toHaveBeenCalled();
    expect(connection).toHaveBeenLastCalledWith("disconnected");
    const updates = await finish(
      data.fetchOrdersUpdatedSince(new Date(Date.now() - 60000).toISOString()),
    );
    expect(
      updates.filter(
        (o) => !initial.some((i) => i.id === o.id) && o.status === "new",
      ),
    ).toHaveLength(2);
    expect(
      mergeLiveOrders(mergeLiveOrders(initial, updates), updates),
    ).toHaveLength(initial.length + 2);
    await data.runLiveMockAction("reconnect");
    await vi.advanceTimersByTimeAsync(500);
    expect(insert).toHaveBeenCalledTimes(2);
    await data.runLiveMockAction("other_silent");
    await vi.advanceTimersByTimeAsync(500);
    expect(update).not.toHaveBeenCalled();
    stop();
  });
  it("停用只读、暂停同源、登录过期和一次 NETWORK", async () => {
    const order = (await finish(data.listLiveOrders())).find(
      (o) => o.status === "new",
    )!;
    expect(
      (await finish(data.setAcceptingOrders(false))).is_accepting_orders,
    ).toBe(false);
    expect(
      (await finish(data.getTableMenu("demo-a1"))).store.is_accepting_orders,
    ).toBe(false);
    await data.configureLiveMock({ fail_status: true });
    await expect(
      finish(
        data.updateOrderStatus(order.id, { to: "accepted", expected: "new" }),
      ),
    ).rejects.toMatchObject({ code: "NETWORK" });
    await data.runMockAction("suspend", "demo-a1");
    await expect(finish(data.setAcceptingOrders(true))).rejects.toMatchObject({
      code: "STORE_SUSPENDED",
    });
    await expect(
      finish(
        data.updateOrderStatus(order.id, { to: "accepted", expected: "new" }),
      ),
    ).rejects.toMatchObject({ code: "STORE_SUSPENDED" });
    expect((await finish(data.listLiveOrders())).length).toBeGreaterThan(0);
    await data.configureLiveMock({ expired: true });
    await expect(
      finish(data.fetchOrdersUpdatedSince(new Date(0).toISOString())),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });
  it("今日已上菜按 served_at 过滤，隔天不再显示昨日订单", async () => {
    expect(await finish(data.listServedToday())).toHaveLength(3);
    vi.setSystemTime(new Date("2026-11-12T00:01:00+08:00"));
    expect(await finish(data.listServedToday())).toHaveLength(0);
  });
  it("按马来西亚午夜分日、按 updated_at 合并，旧事件不能倒退", () => {
    const { start, end } = malaysiaDay(Date.parse("2026-11-11T00:01:00+08:00"));
    expect(new Date(start).toISOString()).toBe("2026-11-10T16:00:00.000Z");
    expect(end - start).toBe(86400000);
    const old = {
      id: "a",
      updated_at: "2026-11-11T00:00:00.000Z",
      status: "new",
    } as LiveOrder;
    const newer = {
      ...old,
      updated_at: "2026-11-11T00:01:00.000Z",
      status: "served",
    } as LiveOrder;
    expect(mergeLiveOrders([newer], [old, newer])).toEqual([newer]);
  });
});

it("scopes reads and writes to the authenticated store", async () => {
  const ownerOrders = await finish(data.listLiveOrders());
  identity("disabled");
  expect((await finish(data.getStoreStatus())).status).toBe("suspended");
  for (const request of [
    () =>
      data.updateOrderStatus(ownerOrders[0].id, {
        to: "accepted",
        expected: "new",
      }),
    () => data.setAcceptingOrders(true),
  ])
    await expect(finish<unknown>(request())).rejects.toMatchObject({
      code: "STORE_SUSPENDED",
    });
  identity("new");
  expect(await finish(data.listLiveOrders())).toEqual([]);
  expect(await finish(data.listServedToday())).toEqual([]);
  expect(
    await finish(data.fetchOrdersUpdatedSince(new Date(0).toISOString())),
  ).toEqual([]);
  await expect(
    finish(
      data.updateOrderStatus(ownerOrders[0].id, {
        to: "accepted",
        expected: "new",
      }),
    ),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  await finish(data.setAcceptingOrders(false));
  identity("owner");
  expect((await finish(data.getStoreStatus())).is_accepting_orders).toBe(true);
  identity(null);
  for (const request of [
    () => data.listLiveOrders(),
    () => data.listServedToday(),
    () => data.fetchOrdersUpdatedSince(new Date(0).toISOString()),
    () => data.getStoreStatus(),
    () => data.setAcceptingOrders(true),
    () =>
      data.updateOrderStatus(ownerOrders[0].id, {
        to: "accepted",
        expected: "new",
      }),
  ])
    await expect(finish<unknown>(request())).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
});
it("does not deliver orders to another store or an old session subscription", async () => {
  const callbacks = {
    onInsert: vi.fn(),
    onUpdate: vi.fn(),
    onConnectionChange: vi.fn(),
  };
  identity("new");
  const stopWrong = data.subscribeStoreOrders("store-0", callbacks);
  await vi.advanceTimersByTimeAsync(500);
  expect(callbacks.onConnectionChange).toHaveBeenLastCalledWith("disconnected");
  expect(callbacks.onInsert).not.toHaveBeenCalled();
  stopWrong();
  identity("owner");
  const stop = data.subscribeStoreOrders("store-0", callbacks);
  await vi.advanceTimersByTimeAsync(500);
  identity("new");
  await data.runLiveMockAction("new");
  await vi.advanceTimersByTimeAsync(500);
  expect(callbacks.onConnectionChange).toHaveBeenLastCalledWith("disconnected");
  expect(callbacks.onInsert).not.toHaveBeenCalled();
  expect(callbacks.onUpdate).not.toHaveBeenCalled();
  stop();
});

it("keeps controls on the session store and available without a session", async () => {
  const initial = await finish(data.listLiveOrders());
  identity("new");
  await data.runLiveMockAction("three");
  expect(await finish(data.listLiveOrders())).toEqual([]);
  identity("owner");
  expect(await finish(data.listLiveOrders())).toHaveLength(initial.length);
  identity(null);
  await data.runLiveMockAction("new");
  identity("owner");
  expect(await finish(data.listLiveOrders())).toHaveLength(initial.length + 1);
});
