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
      if (!(i in slots)) slots[i] = initial;
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
const { TablesPageD } = await import("../lib/ui/store-d");
type Session = Awaited<ReturnType<typeof d.getSession>>;
type Tables = Awaited<ReturnType<typeof d.listStoreTables>>;
let tree: ReactNode;
let slots: unknown[];
let session: Session;
let initialTables: Tables;
let callbacks: ((s: Session) => void)[];
let pending: ((tables: Tables) => void)[];
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
    tree = run(TablesPageD, slots);
    await vi.runAllTimersAsync();
  }
  tree = run(TablesPageD, slots);
}
function emit(next: Session) {
  session = next;
  callbacks.forEach((callback) => callback(next));
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
  const read = Promise.all([d.getSession(), d.listStoreTables()]);
  await vi.runAllTimersAsync();
  [session, initialTables] = await read;
  slots = [];
  callbacks = [];
  pending = [];
  hooks.cleanups = [];
  hooks.effects = [];
  vi.spyOn(d, "getSession").mockImplementation(async () => session);
  vi.spyOn(d, "onSessionChange").mockImplementation((callback) => {
    callbacks.push(callback);
    return () => { callbacks = callbacks.filter((cb) => cb !== callback); };
  });
  vi.spyOn(d, "listStoreTables").mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
});
afterEach(() => {
  hooks.cleanups.forEach((cleanup) => cleanup?.());
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("same-session INITIAL_SESSION before the first response preserves initial table data", async () => {
  await flush();
  expect(d.listStoreTables).toHaveBeenCalledTimes(1);
  emit(session);
  emit(session);
  await flush();
  expect(d.listStoreTables).toHaveBeenCalledTimes(1);
  pending[0](initialTables);
  await flush();
  expect(JSON.stringify(tree)).toContain("A1");
  expect(JSON.stringify(tree)).not.toContain("还没有桌子");
  expect(find(tree, (e) => e.type === "table")).toHaveLength(1);
  emit(session);
  await flush();
  expect(d.listStoreTables).toHaveBeenCalledTimes(1);
});
it("identity changes reload tables and a late previous-identity response cannot replace new data", async () => {
  await flush();
  pending[0](initialTables);
  await flush();
  expect(JSON.stringify(tree)).toContain("A1");
  emit({ ...session!, user_id: "second-user" });
  await flush();
  expect(d.listStoreTables).toHaveBeenCalledTimes(2);
  emit({ ...session!, user_id: "third-user" });
  await flush();
  expect(d.listStoreTables).toHaveBeenCalledTimes(3);
  pending[2]([{ ...initialTables[0], label: "新身份桌号" }]);
  await flush();
  expect(JSON.stringify(tree)).toContain("新身份桌号");
  expect(JSON.stringify(tree)).not.toContain('"A1"');
  pending[1]([{ ...initialTables[0], label: "过期身份桌号" }]);
  await flush();
  expect(JSON.stringify(tree)).toContain("新身份桌号");
  expect(JSON.stringify(tree)).not.toContain("过期身份桌号");
});
