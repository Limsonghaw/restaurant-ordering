import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LiveOrder } from "../lib/data/types";
const mocks = vi.hoisted(() => ({
  client: {} as Record<string, unknown>,
  store: vi.fn(),
}));
vi.mock("../lib/data/supabase/me", () => ({
  getClient: async () => mocks.client,
  storeContext: mocks.store,
}));
vi.mock("../lib/supabase/server", () => ({
  createClient: async () => mocks.client,
}));
import { getStoreTableQrLinks } from "../lib/data/supabase/table-qr";
import { getStoreHistory } from "../lib/data/supabase/history";
import {
  fetchOrdersUpdatedSince,
  listLiveOrders,
  listServedToday,
  subscribeStoreOrders,
} from "../lib/data/supabase/live-orders";
import { verifyTableCode } from "../lib/qr";
const store = "11111111-1111-1111-1111-111111111111";
const table = "22222222-2222-2222-2222-222222222222";
let calls: { method: string; args: unknown[] }[][];
let pages: unknown[][];
function from() {
  const callsForQuery: { method: string; args: unknown[] }[] = [];
  calls.push(callsForQuery);
  const query: Record<string, unknown> = {};
  for (const method of [
    "select",
    "eq",
    "is",
    "in",
    "gt",
    "gte",
    "lt",
    "or",
    "order",
    "limit",
    "returns",
  ])
    query[method] = (...args: unknown[]) => {
      callsForQuery.push({ method, args });
      return query;
    };
  query.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve({ data: pages.shift() ?? [], error: null }).then(resolve);
  return query;
}
beforeEach(() => {
  calls = [];
  pages = [];
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-11T12:00:00+08:00"));
  mocks.store.mockReset().mockResolvedValue(store);
  mocks.client = {
    from: vi.fn(from),
    rpc: vi.fn(async () => ({ data: { store: { id: store } }, error: null })),
  };
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://configured.example.invalid/a");
  vi.stubEnv("QR_SIGNING_SECRET", "test-only-signing-secret");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
it("QR uses configured origin, signs only own undeleted tables and shares S1", async () => {
  pages = [[{ id: table, label: "A1", qr_version: 3 }]];
  const [link] = await getStoreTableQrLinks([table]);
  expect(link).toMatchObject({ table_id: table, label: "A1" });
  expect(new URL(link.url).origin).toBe("https://configured.example.invalid");
  expect(verifyTableCode(new URL(link.url).pathname.slice(3))).toEqual({
    store_id: store,
    table_id: table,
    qr_version: 3,
  });
  expect(calls[0]).toContainEqual({ method: "eq", args: ["store_id", store] });
  expect(calls[0]).toContainEqual({ method: "is", args: ["deleted_at", null] });
});
it.each(["cross-store", "deleted", "unknown"])(
  "QR rejects %s table",
  async () => {
    await expect(getStoreTableQrLinks([table])).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  },
);
it("QR rejects anonymous/no store", async () => {
  mocks.client.rpc = vi.fn(async () => ({ data: null, error: null }));
  await expect(getStoreTableQrLinks([table])).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
});
it("QR requires configured site without localhost fallback", async () => {
  pages = [[{ id: table, label: "A", qr_version: 1 }]];
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
  await expect(getStoreTableQrLinks([table])).rejects.toThrow(
    "NEXT_PUBLIC_SITE_URL is required",
  );
});
it.each([[], ["invalid"], Array(201).fill(table)])(
  "QR validates IDs and size",
  async (ids) => {
    await expect(getStoreTableQrLinks(ids as string[])).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  },
);
it.each(["2026-02-31", "2026-11-12", "2026-2-01", "bad", "2026-00-01"])(
  "history rejects %s",
  async (date) => {
    await expect(getStoreHistory(date)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    expect(mocks.client.from).not.toHaveBeenCalled();
  },
);
it("history scopes, paginates, sorts and uses Malaysia half-open day", async () => {
  const row = { id: table, created_at: "2026-11-11T01:00:00Z" };
  pages = [Array(500).fill(row), [{ ...row, id: "last" }]];
  const stats = {
    timezone: "Asia/Kuala_Lumpur",
    currency: "MYR",
    revenue_cents: 123,
  };
  mocks.client.rpc = vi.fn(async () => ({ data: stats, error: null }));
  expect(await getStoreHistory("2026-11-11")).toEqual({
    orders: [...Array(500).fill(row), { ...row, id: "last" }],
    stats,
  });
  expect(mocks.client.rpc).toHaveBeenCalledWith("get_store_daily_stats", {
    p_date: "2026-11-11",
  });
  for (const call of calls) {
    expect(call).toContainEqual({ method: "eq", args: ["store_id", store] });
    expect(call).toContainEqual({
      method: "gte",
      args: ["created_at", "2026-11-10T16:00:00.000Z"],
    });
    expect(call).toContainEqual({
      method: "lt",
      args: ["created_at", "2026-11-11T16:00:00.000Z"],
    });
  }
});
it("history rejects no store and anonymous", async () => {
  mocks.store.mockRejectedValue({ code: "UNAUTHENTICATED" });
  await expect(getStoreHistory("2026-11-11")).rejects.toMatchObject({
    code: "FORBIDDEN",
  });
});

it("listLiveOrders keysets through 500-row pages including latest", async () => {
  const row = { id: table, created_at: "2026-11-11T00:00:00Z" } as LiveOrder;
  pages = [
    Array(500).fill(row),
    [{ ...row, id: "latest", created_at: "2026-11-11T03:00:00Z" }],
  ];
  expect(await listLiveOrders()).toHaveLength(501);
  expect(calls).toHaveLength(2);
  for (const call of calls) {
    expect(call).toContainEqual({ method: "limit", args: [500] });
    expect(call).toContainEqual({ method: "eq", args: ["store_id", store] });
    expect(call).toContainEqual({
      method: "in",
      args: ["status", ["new", "accepted"]],
    });
  }
  expect(calls[1]).toContainEqual({
    method: "or",
    args: [
      `created_at.gt.${row.created_at},and(created_at.eq.${row.created_at},id.gt.${table})`,
    ],
  });
});
it("listServedToday keysets through 500-row pages including latest", async () => {
  const row = { id: table, served_at: "2026-11-11T02:00:00Z" } as LiveOrder;
  pages = [
    Array(500).fill(row),
    [{ ...row, id: "latest", served_at: "2026-11-11T00:00:00Z" }],
  ];
  expect(await listServedToday()).toHaveLength(501);
  expect(calls).toHaveLength(2);
  for (const call of calls) {
    expect(call).toContainEqual({ method: "limit", args: [500] });
    expect(call).toContainEqual({ method: "eq", args: ["store_id", store] });
    expect(call).toContainEqual({ method: "eq", args: ["status", "served"] });
    expect(call).toContainEqual({
      method: "gte",
      args: ["served_at", "2026-11-10T16:00:00.000Z"],
    });
    expect(call).toContainEqual({
      method: "lt",
      args: ["served_at", "2026-11-11T16:00:00.000Z"],
    });
  }
  expect(calls[1]).toContainEqual({
    method: "or",
    args: [
      `served_at.lt.${row.served_at},and(served_at.eq.${row.served_at},id.gt.${table})`,
    ],
  });
});
it("incremental reads clamp ancient since and keyset through 500-row pages including latest", async () => {
  const row = { id: table, updated_at: "2026-11-11T00:00:00Z" } as LiveOrder;
  pages = [
    Array(500).fill(row),
    [{ ...row, id: "latest", updated_at: "2026-11-11T03:00:00Z" }],
  ];
  expect(await fetchOrdersUpdatedSince("1970-01-01T00:00:00Z")).toHaveLength(
    501,
  );
  expect(calls).toHaveLength(2);
  for (const call of calls) {
    expect(call).toContainEqual({ method: "limit", args: [500] });
    expect(call).toContainEqual({ method: "eq", args: ["store_id", store] });
    expect(call).toContainEqual({
      method: "gt",
      args: ["updated_at", "2026-11-10T15:59:30.000Z"],
    });
  }
  expect(calls[1]).toContainEqual({
    method: "or",
    args: [
      `updated_at.gt.${row.updated_at},and(updated_at.eq.${row.updated_at},id.gt.${table})`,
    ],
  });
});
it.each([true, false])(
  "subscription watermark uses server rows (nonempty=%s), not browser now",
  async (nonempty) => {
    const handlers: ((payload: { new: object; eventType: string }) => void)[] =
      [];
    const channel = {
      on: vi.fn((_event, _filter, handler) => {
        handlers.push(handler);
        return channel;
      }),
      subscribe: vi.fn(),
    };
    mocks.client.channel = vi.fn(() => channel);
    mocks.client.realtime = { setAuth: vi.fn() };
    mocks.client.removeChannel = vi.fn();
    pages = [nonempty ? [{ updated_at: "2026-11-11T01:00:00Z" }] : [], []];
    const stop = subscribeStoreOrders(store, {
      onInsert: vi.fn(),
      onUpdate: vi.fn(),
      onConnectionChange: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(0);
    handlers[0]({ new: {}, eventType: "UPDATE" });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.at(-1)).toContainEqual({
      method: "gt",
      args: [
        "updated_at",
        nonempty ? "2026-11-11T00:59:30.000Z" : "2026-11-10T15:59:30.000Z",
      ],
    });
    stop();
  },
);
