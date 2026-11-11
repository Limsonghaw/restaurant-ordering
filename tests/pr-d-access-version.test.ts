import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type ReactElement, type ReactNode } from "react";
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
      const slots = hooks.slots;
      if (!(i in slots))
        slots[i] = typeof initial === "function" ? initial() : initial;
      return [
        slots[i],
        (value: unknown) => {
          const next = typeof value === "function" ? value(slots[i]) : value;
          if (!Object.is(next, slots[i])) hooks.dirty = true;
          slots[i] = next;
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

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("next/image", () => ({ default: () => null }));
vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", "mock");
const d = await import("../lib/data");
const { BillsPageD } = await import("../lib/ui/store-d");
type Session = Awaited<ReturnType<typeof d.getSession>>;
type Tables = Awaited<ReturnType<typeof d.listStoreTables>>;
type Bills = Awaited<ReturnType<typeof d.listStoreBills>>;
type Detail = Awaited<ReturnType<typeof d.getStoreBill>>;
let tree: ReactNode;
let slots: unknown[];
let session: Session;
let initialTables: Tables;
let initialBills: Bills;
let callbacks: ((s: Session) => void)[];
let pendingBills: ((page: Bills) => void)[];
let pendingDetail: ((detail: Detail) => void)[];
function billRow(label = "A1") {
  return {
    id: "bill-a1",
    store_id: "s",
    table_id: "a1",
    table_label: label,
    status: "open" as const,
    opened_at: "2026-11-11T00:00:00.000Z",
    paid_at: null,
    updated_at: "2026-11-11T00:00:00.000Z",
    service_charge_bp: 1000,
    sst_bp: 600,
    is_estimate: true,
    order_count: 1,
    unserved_count: 0,
    currency: "MYR" as const,
    subtotal_cents: 1000,
    service_charge_cents: 100,
    sst_cents: 66,
    rounding_cents: -1,
    total_cents: 1165,
  };
}
function find(
  node: ReactNode,
  predicate: (e: ReactElement<Record<string, unknown>>) => boolean,
): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap((n) => find(n, predicate));
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const e = node as ReactElement<Record<string, unknown>>;
  return [
    ...(predicate(e) ? [e] : []),
    ...find(e.props.children as ReactNode, predicate),
  ];
}
function run(component: () => ReactNode, slots: unknown[]) {
  hooks.slots = slots;
  hooks.cursor = 0;
  const node = component();
  hooks.effects.splice(0).forEach((effect) => effect());
  return node;
}
async function flush() {
  for (let i = 0; i < 8; i++) {
    tree = run(BillsPageD, slots);
    await vi.runAllTimersAsync();
  }
  tree = run(BillsPageD, slots);
}
function emit(next: Session) {
  session = next;
  callbacks.forEach((callback) => callback(next));
}
function click(label: string) {
  const button =
    find(
      tree,
      (e) => typeof e.type !== "string" && String(e.props.children) === label,
    )[0] ??
    find(
      tree,
      (e) => e.type === "button" && String(e.props.children) === label,
    )[0];
  expect(button, `missing button ${label}`).toBeTruthy();
  (button.props.onClick as () => void)();
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", new EventTarget());
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
  });
  await d.authMockAction("identity", "owner");
  const read = Promise.all([
    d.getSession(),
    d.listStoreTables(),
    d.listStoreBills("open"),
  ]);
  await vi.runAllTimersAsync();
  [session, initialTables, initialBills] = await read;
  if (!initialBills.bills.length) {
    initialBills = {
      bills: [billRow()],
      total: 1,
      page: 1,
      page_size: 20,
    };
  }
  slots = [];
  callbacks = [];
  pendingBills = [];
  pendingDetail = [];
  hooks.cleanups = [];
  hooks.effects = [];
  vi.spyOn(d, "getSession").mockImplementation(async () => session);
  vi.spyOn(d, "onSessionChange").mockImplementation((callback) => {
    callbacks.push(callback);
    return () => {
      callbacks = callbacks.filter((cb) => cb !== callback);
    };
  });
  vi.spyOn(d, "listStoreTables").mockResolvedValue(initialTables);
  vi.spyOn(d, "listStoreBills").mockImplementation(
    () => new Promise((resolve) => pendingBills.push(resolve)),
  );
  vi.spyOn(d, "getStoreBill").mockImplementation(
    () => new Promise((resolve) => pendingDetail.push(resolve)),
  );
});
afterEach(() => {
  hooks.cleanups.forEach((cleanup) => cleanup?.());
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("changing bill filters does not drop an in-flight bill detail", async () => {
  await flush();
  pendingBills[0](initialBills);
  await flush();
  expect(JSON.stringify(tree)).toContain("查看详情");
  click("查看详情");
  await flush();
  const select = find(tree, (e) => e.type === "select")[0];
  expect(select).toBeTruthy();
  (select.props.onChange as (e: { target: { value: string } }) => void)({
    target: { value: initialTables[0]?.id ?? "a1" },
  });
  await flush();
  pendingDetail[0]({ ...billRow("进行中的详情桌"), orders: [] });
  await flush();
  expect(JSON.stringify(tree)).toContain("进行中的详情桌");
});
it("an identity change still discards a late bill detail from the previous store", async () => {
  await flush();
  pendingBills[0](initialBills);
  await flush();
  click("查看详情");
  await flush();
  emit({ ...session!, user_id: "second-user" });
  await flush();
  pendingDetail[0]({ ...billRow("过期身份账单"), orders: [] });
  await flush();
  expect(JSON.stringify(tree)).not.toContain("过期身份账单");
});
