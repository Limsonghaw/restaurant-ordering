import { afterEach, beforeEach, expect, it, vi } from "vitest";
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", "mock");
  vi.stubGlobal("window", new EventTarget());
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
    removeItem: (k: string) => values.delete(k),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("重置后新桌码不会误报，旧令牌访问才收到 qr_rotated", async () => {
  const d = await import("../lib/data");
  await d.runMockAction("rotate", "demo-a1");
  const result = d.getTableBill("demo-a1-r1").catch((e) => e);
  await vi.runAllTimersAsync();
  expect(await result).toMatchObject({ view: "table" });
  const old = d.getTableBill("demo-a1").catch((e) => e);
  await vi.runAllTimersAsync();
  expect(await old).toMatchObject({
    code: "BILL_TOKEN_EXPIRED",
    details: { reason: "qr_rotated" },
  });
});
