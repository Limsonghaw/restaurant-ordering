import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { LiveOrder, StoreOrderCallbacks } from "../lib/data/types";
const fake = vi.hoisted(() => ({
  listLiveOrders: vi.fn(),
  fetchOrdersUpdatedSince: vi.fn(),
  subscribeStoreOrders: vi.fn(),
}));
vi.mock("../lib/data/live", () => fake);
import { createStoreChannel } from "../lib/realtime/useStoreChannel";
let callbacks: StoreOrderCallbacks;
let documentFake: EventTarget & { visibilityState: string };
const stop = vi.fn();
const row = (status = "new", updated = "2026-11-11T01:00:00Z") =>
  ({
    id: "o",
    created_at: "2026-11-11T00:00:00Z",
    updated_at: updated,
    status,
  }) as LiveOrder;
let controller: ReturnType<typeof createStoreChannel>;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T02:00:00Z"));
  vi.clearAllMocks();
  fake.listLiveOrders.mockResolvedValue([row()]);
  fake.fetchOrdersUpdatedSince.mockResolvedValue([]);
  fake.subscribeStoreOrders.mockImplementation((_id, cb) => {
    callbacks = cb;
    return stop;
  });
  documentFake = Object.assign(new EventTarget(), {
    visibilityState: "visible",
  });
  vi.stubGlobal("document", documentFake);
});
afterEach(() => {
  controller?.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("pulls on reconnect, visibility and 60s with watermark overlap; merges ids without regressing status", async () => {
  const notify = vi.fn();
  controller = createStoreChannel("s", notify);
  await vi.advanceTimersByTimeAsync(0);
  callbacks.onInsert(row());
  callbacks.onUpdate(row("accepted", "2026-11-11T01:01:00Z"));
  callbacks.onUpdate(row());
  expect(notify.mock.lastCall?.[0]).toEqual([
    row("accepted", "2026-11-11T01:01:00Z"),
  ]);
  callbacks.onConnectionChange("connected");
  await vi.advanceTimersByTimeAsync(0);
  expect(fake.fetchOrdersUpdatedSince).toHaveBeenLastCalledWith(
    "2026-11-11T01:00:30.000Z",
  );
  documentFake.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(fake.fetchOrdersUpdatedSince).toHaveBeenCalledTimes(2);
  documentFake.visibilityState = "hidden";
  documentFake.dispatchEvent(new Event("visibilitychange"));
  expect(fake.fetchOrdersUpdatedSince).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60000);
  expect(fake.fetchOrdersUpdatedSince).toHaveBeenCalledTimes(3);
  callbacks.onConnectionChange("disconnected");
  await vi.advanceTimersByTimeAsync(1000);
  expect(stop).toHaveBeenCalled();
  expect(fake.subscribeStoreOrders).toHaveBeenCalledTimes(2);
  fake.fetchOrdersUpdatedSince.mockResolvedValue([
    row("served", "2026-11-11T01:02:00Z"),
    row("served", "2026-11-11T01:02:00Z"),
  ]);
  callbacks.onConnectionChange("connected");
  await vi.advanceTimersByTimeAsync(0);
  expect(notify.mock.lastCall?.[0]).toEqual([
    row("served", "2026-11-11T01:02:00Z"),
  ]);
  controller.stop();
  expect(vi.getTimerCount()).toBe(0);
  const calls = fake.fetchOrdersUpdatedSince.mock.calls.length;
  documentFake.visibilityState = "visible";
  documentFake.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(120000);
  expect(fake.fetchOrdersUpdatedSince).toHaveBeenCalledTimes(calls);
});
it("rings every ten seconds only after user unlock and only while new orders exist; closes audio", async () => {
  const start = vi.fn(),
    close = vi.fn().mockResolvedValue(undefined),
    resume = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      currentTime = 0;
      destination = {};
      resume = resume;
      close = close;
      createOscillator() {
        return {
          frequency: { setValueAtTime: vi.fn() },
          connect: vi.fn(),
          start,
          stop: vi.fn(),
        };
      }
      createGain() {
        return {
          gain: {
            setValueAtTime: vi.fn(),
            exponentialRampToValueAtTime: vi.fn(),
          },
          connect: vi.fn(),
        };
      }
    },
  );
  controller = createStoreChannel("s", vi.fn());
  await vi.advanceTimersByTimeAsync(20000);
  expect(start).not.toHaveBeenCalled();
  expect(await controller.enableSound()).toBe(true);
  await vi.advanceTimersByTimeAsync(20000);
  expect(start).toHaveBeenCalledTimes(2);
  callbacks.onUpdate(row("accepted", "2026-11-11T01:01:00Z"));
  await vi.advanceTimersByTimeAsync(10000);
  expect(start).toHaveBeenCalledTimes(2);
  controller.stop();
  expect(close).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it("ignores initial requests resolving after unmount", async () => {
  let resolve!: (rows: LiveOrder[]) => void;
  fake.listLiveOrders.mockReturnValue(
    new Promise((r) => {
      resolve = r;
    }),
  );
  const notify = vi.fn();
  controller = createStoreChannel("s", notify);
  controller.stop();
  resolve([row()]);
  await vi.advanceTimersByTimeAsync(0);
  expect(notify).not.toHaveBeenCalled();
});
