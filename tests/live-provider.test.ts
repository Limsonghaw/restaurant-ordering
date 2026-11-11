import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { DataError, type LiveOrder, type Session } from "../lib/data/types";
import { liveErrorMessage } from "../lib/ui/live-errors";

// Run the provider's hooks and effects in node without adding a DOM dependency.
const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  dirty: false,
  effects: [] as (() => void)[],
  cleanups: [] as (() => void)[],
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState(initial: unknown) {
      const i = hooks.cursor++;
      if (!(i in hooks.slots)) hooks.slots[i] = initial;
      return [
        hooks.slots[i],
        (value: unknown) => {
          const next =
            typeof value === "function" ? value(hooks.slots[i]) : value;
          if (!Object.is(next, hooks.slots[i])) hooks.dirty = true;
          hooks.slots[i] = next;
        },
      ];
    },
    useRef(initial: unknown) {
      const i = hooks.cursor++;
      return (hooks.slots[i] ??= { current: initial });
    },
    useCallback(fn: unknown, deps: unknown[]) {
      const i = hooks.cursor++;
      const old = hooks.slots[i] as
        { deps: unknown[]; fn: unknown } | undefined;
      if (!old || deps.some((d, n) => !Object.is(d, old.deps[n])))
        hooks.slots[i] = { deps, fn };
      return (hooks.slots[i] as { fn: unknown }).fn;
    },
    useEffect(fn: () => (() => void) | void, deps: unknown[]) {
      const i = hooks.cursor++;
      const old = hooks.slots[i] as unknown[] | undefined;
      if (!old || deps.some((d, n) => !Object.is(d, old[n]))) {
        hooks.slots[i] = deps;
        hooks.effects.push(() => {
          hooks.cleanups[i]?.();
          hooks.cleanups[i] = fn() || (() => {});
        });
      }
    },
  };
});
vi.mock("next/navigation", () => ({ usePathname: () => "/store/live" }));
vi.mock("../lib/ui/store-shell", () => ({ StoreShell: "shell" }));
vi.mock("../lib/ui/common", () => ({
  Banner: "banner",
  Button: "button",
  ConfirmDialog: "confirm",
  Toast: "toast",
}));
const api = vi.hoisted(() => ({
  getSession: vi.fn(),
  onSessionChange: vi.fn(),
  getStoreStatus: vi.fn(),
  listLiveOrders: vi.fn(),
  listServedToday: vi.fn(),
  fetchOrdersUpdatedSince: vi.fn(),
  subscribeStoreOrders: vi.fn(),
  updateOrderStatus: vi.fn(),
  blockClientFromOrder: vi.fn(),
  setAcceptingOrders: vi.fn(),
}));
vi.mock("../lib/data", async () => ({
  ...(await import("../lib/data/types")),
  ...api,
  isMock: false,
}));
const { LiveProvider } = await import("../lib/ui/live-provider");
let tree: ReturnType<typeof LiveProvider>;
function render() {
  do {
    hooks.dirty = false;
    hooks.cursor = 0;
    tree = LiveProvider({ children: null });
    hooks.effects.splice(0).forEach((effect) => effect());
  } while (hooks.dirty);
  return tree.props.value;
}
async function flush() {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve();
    render();
  }
}
function nodes(
  type: string,
  node: ReactNode = tree,
): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node))
    return node.flatMap((child) => nodes(type, child ?? null));
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<{ children?: ReactNode }>;
  return [
    ...(element.type === type
      ? [element as ReactElement<Record<string, unknown>>]
      : []),
    ...nodes(type, element.props.children ?? null),
    ...nodes(type, (element.props as { banners?: ReactNode }).banners ?? null),
  ];
}
const order = {
  id: "order-a",
  status: "new",
  updated_at: new Date().toISOString(),
  dining_tables: { label: "A1" },
  seq_in_bill: 1,
} as LiveOrder;
let session: Session;
let sessionChanged: (s: Session | null) => void;
const unsubscribe = vi.fn();
const activeStore = { name: "店", status: "active", is_accepting_orders: true };
beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  hooks.slots = [];
  hooks.cleanups = [];
  hooks.effects = [];
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal(
    "document",
    Object.assign(new EventTarget(), {
      title: "餐厅",
      visibilityState: "visible",
    }),
  );
  vi.stubGlobal("navigator", {});
  session = {
    user_id: "user-a",
    store: { id: "store-a", status: "active" },
  } as Session;
  api.getSession.mockImplementation(async () => session);
  api.onSessionChange.mockImplementation((callback) => {
    sessionChanged = callback;
    return vi.fn();
  });
  api.getStoreStatus.mockResolvedValue(activeStore);
  api.listLiveOrders.mockResolvedValue([order]);
  api.listServedToday.mockResolvedValue([]);
  api.fetchOrdersUpdatedSince.mockResolvedValue([]);
  api.subscribeStoreOrders.mockReturnValue(unsubscribe);
  api.updateOrderStatus.mockResolvedValue({ ...order, status: "accepted" });
  api.setAcceptingOrders.mockResolvedValue(activeStore);
  render();
  await flush();
  render().start();
  await flush();
});
afterEach(() => {
  hooks.cleanups.forEach((cleanup) => cleanup?.());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it.each(["user", "store", "logout"])(
  "clears orders and stops subscriptions and timers on %s change",
  async (kind) => {
    expect(render().orders).toHaveLength(1);
    sessionChanged(
      kind === "logout"
        ? null
        : {
            ...session,
            user_id: kind === "user" ? "user-b" : session.user_id,
            store: {
              ...session.store!,
              id: kind === "store" ? "store-b" : "store-a",
            },
          },
    );
    await flush();
    expect(render().orders).toEqual([]);
    expect(render().started).toBe(false);
    expect(unsubscribe).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const reads = api.fetchOrdersUpdatedSince.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120000);
    expect(api.fetchOrdersUpdatedSince).toHaveBeenCalledTimes(reads);
  },
);
it("expires and clears old orders on UNAUTHENTICATED", async () => {
  api.updateOrderStatus.mockRejectedValue(
    new DataError("UNAUTHENTICATED", "private"),
  );
  await render().change(order, { to: "accepted", expected: "new" });
  await flush();
  expect(render().started).toBe(false);
  expect(render().orders).toEqual([]);
  expect(unsubscribe).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it("ignores an old write response after switching sessions", async () => {
  let resolve!: (o: LiveOrder) => void;
  api.updateOrderStatus.mockReturnValue(
    new Promise<LiveOrder>((done) => {
      resolve = done;
    }),
  );
  const pending = render().change(order, { to: "accepted", expected: "new" });
  sessionChanged(null);
  await flush();
  resolve(order);
  await pending;
  await flush();
  expect(render().orders).toEqual([]);
});
it("rejects stale change, pause confirmation and retry handlers after suspension", async () => {
  const stale = render();
  stale.toggleAccepting();
  render();
  const confirm = nodes("confirm")[0].props.onConfirm as () => void;
  api.updateOrderStatus.mockRejectedValue(new DataError("NETWORK", "private"));
  await stale.change(order, { to: "accepted", expected: "new" });
  await flush();
  const retry = nodes("button").find((n) => n.props.children === "重试")!.props
    .onClick as () => void;
  sessionChanged({
    ...session,
    store: { ...session.store!, status: "suspended" },
  });
  // Invoke captured handlers before React renders the new state as well.
  confirm();
  retry();
  stale.toggleAccepting();
  expect(await stale.change(order, { to: "accepted", expected: "new" })).toBe(
    false,
  );
  await flush();
  expect(api.updateOrderStatus).toHaveBeenCalledTimes(1);
  expect(api.setAcceptingOrders).not.toHaveBeenCalled();
  expect(nodes("confirm")).toHaveLength(0);
  expect(
    nodes("button").filter((n) => n.props.children === "重试"),
  ).toHaveLength(0);
});
it("shows an explicit STORE_SUSPENDED message and blocks subsequent writes", async () => {
  api.setAcceptingOrders.mockRejectedValue(
    new DataError("STORE_SUSPENDED", "private"),
  );
  render().toggleAccepting();
  render();
  (nodes("confirm")[0].props.onConfirm as () => void)();
  await flush();
  expect(render().error).toBe("店铺已停用，无法进行操作，请联系管理员");
  expect(nodes("confirm")).toHaveLength(0);
  expect(
    await render().change(order, { to: "accepted", expected: "new" }),
  ).toBe(false);
  expect(api.updateOrderStatus).not.toHaveBeenCalled();
});
it("shows only generic text for unmapped data errors in the live error banner", async () => {
  api.getStoreStatus.mockRejectedValue(
    new DataError("NOT_IMPLEMENTED", "secret SQL details"),
  );
  render().reload();
  await flush();
  expect(render().error).toBe("操作没有成功，请稍后再试");
  expect(
    nodes("banner").some(
      (n) => n.props.children === "操作没有成功，请稍后再试",
    ),
  ).toBe(true);
});
it("uses a whitelist for unknown codes and non-data errors", () => {
  for (const error of [
    new Error("private"),
    new DataError("NOT_FOUND", "private"),
    { code: "NETWORK", message: "private" },
    new DataError("toString" as never, "private"),
  ])
    expect(liveErrorMessage(error)).toBe("操作没有成功，请稍后再试");
  expect(liveErrorMessage(new DataError("NETWORK", "private"))).toContain(
    "网络出错",
  );
});
it("ignores pending reload data and realtime callbacks after a session switch", async () => {
  const callbacks = api.subscribeStoreOrders.mock.calls[0][1];
  let resolve!: (orders: LiveOrder[]) => void;
  api.listLiveOrders.mockReturnValue(
    new Promise<LiveOrder[]>((done) => {
      resolve = done;
    }),
  );
  render().reload();
  await flush();
  sessionChanged(null);
  await flush();
  callbacks.onInsert(order);
  callbacks.onConnectionChange("connected");
  resolve([order]);
  await flush();
  expect(render().orders).toEqual([]);
  expect(render().started).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
it("clears toast timers on session switch", async () => {
  await render().change(order, { to: "accepted", expected: "new" });
  await flush();
  expect(nodes("toast")).toHaveLength(1);
  sessionChanged(null);
  await flush();
  expect(nodes("toast")).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});
it("does not restore retry when a pending write fails after suspension", async () => {
  let reject!: (error: unknown) => void;
  api.updateOrderStatus.mockReturnValue(
    new Promise((_done, fail) => {
      reject = fail;
    }),
  );
  const pending = render().change(order, { to: "accepted", expected: "new" });
  sessionChanged({
    ...session,
    store: { ...session.store!, status: "suspended" },
  });
  await flush();
  reject(new DataError("NETWORK", "private"));
  await pending;
  await flush();
  expect(
    nodes("button").filter((n) => n.props.children === "重试"),
  ).toHaveLength(0);
});
it("reports STORE_SUSPENDED from an order write", async () => {
  api.updateOrderStatus.mockRejectedValue(
    new DataError("STORE_SUSPENDED", "private"),
  );
  await render().change(order, { to: "accepted", expected: "new" });
  await flush();
  expect(render().store?.status).toBe("suspended");
  expect(render().error).toBe("店铺已停用，无法进行操作，请联系管理员");
});
it("also resets when reload observes a new session before the session event arrives", async () => {
  session = { ...session, user_id: "user-b" };
  render().reload();
  await flush();
  expect(render().started).toBe(false);
  expect(render().orders).toEqual([]);
  expect(unsubscribe).toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects and blocks through the guarded provider and removes the live card", async () => {
  api.blockClientFromOrder.mockResolvedValue({
    blocked: true,
    cancelled: true,
  });
  expect(await render().block(order)).toBe(true);
  expect(
    render().orders.find((value: LiveOrder) => value.id === order.id)?.status,
  ).toBe("cancelled");
  expect(nodes("toast")[0].props.children).toContain("已拒单并拉黑这台手机");
});
it("blocks stale reject-and-block entry points after suspension or logout", async () => {
  const stale = render();
  sessionChanged({
    ...session,
    store: { ...session.store!, status: "suspended" },
  });
  expect(await stale.block(order)).toBe(false);
  sessionChanged(null);
  expect(await stale.block(order)).toBe(false);
  expect(api.blockClientFromOrder).not.toHaveBeenCalled();
});
it("ignores reject-and-block responses after switching sessions", async () => {
  let resolve!: () => void;
  api.blockClientFromOrder.mockImplementation(
    () =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const pending = render().block(order);
  sessionChanged(null);
  resolve();
  expect(await pending).toBe(false);
  expect(render().orders).toEqual([]);
  expect(nodes("toast")).toHaveLength(0);
});
it("refreshes processed orders and never displays backend messages on block failure", async () => {
  api.blockClientFromOrder.mockRejectedValueOnce(
    new DataError("NOT_FOUND", "private data"),
  );
  expect(await render().block(order)).toBe(false);
  expect(api.listLiveOrders.mock.calls.length).toBeGreaterThan(1);
  render();
  expect(nodes("toast")[0].props.children).toContain("这张订单已被处理");
  await flush();
  api.blockClientFromOrder.mockRejectedValueOnce(new Error("private data"));
  expect(await render().block(order)).toBe(false);
  render();
  expect(nodes("toast")[0].props.children).toContain("操作没有成功，请重试");
});

it.each(["write", "session"])(
  "keeps suspension after an older pull returns active (%s)",
  async (source) => {
    let resolve!: (value: typeof activeStore) => void;
    api.getStoreStatus.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const stale = render();
    stale.toggleAccepting();
    render();
    const confirm = nodes("confirm")[0].props.onConfirm as () => void;
    document.dispatchEvent(new Event("visibilitychange"));
    if (source === "write") {
      api.blockClientFromOrder.mockRejectedValueOnce(
        new DataError("STORE_SUSPENDED", "private"),
      );
      await stale.block(order);
    } else {
      sessionChanged({
        ...session,
        store: { ...session.store!, status: "suspended" },
      });
    }
    resolve(activeStore);
    await flush();
    expect(render().store?.status).toBe("suspended");
    expect(nodes("shell")[0].props.storeStatus).toBe("suspended");
    expect(await stale.change(order, { to: "accepted", expected: "new" })).toBe(
      false,
    );
    expect(await stale.block(order)).toBe(false);
    confirm();
    stale.toggleAccepting();
    expect(api.updateOrderStatus).not.toHaveBeenCalled();
    expect(api.setAcceptingOrders).not.toHaveBeenCalled();
    expect(api.blockClientFromOrder).toHaveBeenCalledTimes(
      source === "write" ? 1 : 0,
    );
  },
);
it("does not restore toast after block reports UNAUTHENTICATED", async () => {
  api.blockClientFromOrder.mockRejectedValueOnce(
    new DataError("UNAUTHENTICATED", "secret"),
  );
  expect(await render().block(order)).toBe(false);
  await flush();
  expect(render().started).toBe(false);
  expect(render().orders).toEqual([]);
  expect(nodes("toast")).toHaveLength(0);
});
it("ignores an older accepting response after suspension", async () => {
  let resolve!: (value: typeof activeStore) => void;
  api.setAcceptingOrders.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  render().toggleAccepting();
  render();
  (nodes("confirm")[0].props.onConfirm as () => void)();
  sessionChanged({
    ...session,
    store: { ...session.store!, status: "suspended" },
  });
  resolve(activeStore);
  await flush();
  expect(render().store?.status).toBe("suspended");
});

it("adopts store reads by issue order across reload and change events", async () => {
  let resolve!: (value: typeof activeStore) => void;
  api.getStoreStatus.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  render().reload();
  await flush();
  api.getStoreStatus.mockResolvedValueOnce({
    ...activeStore,
    is_accepting_orders: false,
  });
  window.dispatchEvent(new Event("ro-mock:change"));
  await flush();
  expect(render().store?.is_accepting_orders).toBe(false);
  resolve(activeStore);
  await flush();
  expect(render().store?.is_accepting_orders).toBe(false);
});
it("fences old store reads on reset and accepts the new session store", async () => {
  let resolve!: (value: typeof activeStore) => void;
  api.getStoreStatus.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  window.dispatchEvent(new Event("ro-mock:change"));
  session = { ...session, user_id: "user-b" };
  sessionChanged(session);
  await flush();
  api.getStoreStatus.mockResolvedValue({ ...activeStore, name: "新店" });
  render().start();
  await flush();
  resolve(activeStore);
  await flush();
  expect(render().started).toBe(true);
  expect(render().store?.name).toBe("新店");
});
