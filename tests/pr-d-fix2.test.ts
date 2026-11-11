import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Fragment, type ReactElement, type ReactNode } from "react";
import { DataError, type ErrorCode } from "../lib/data/types";
import { tableQrUrl } from "../lib/ui/store-d-helpers";
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

vi.mock("next/navigation", () => ({
  usePathname: () => "/store/tables",
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock("next/image", () => ({ default: () => null }));
vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", "mock");
const { StoreShell } = await import("../lib/ui/store-shell");
const { TablesPageD, storePageMessage } = await import("../lib/ui/store-d");
const d = await import("../lib/data");
const shellSlots: unknown[] = [];
let pageSlots: unknown[] = [];
let oldKey: string | null | undefined;
let tree: ReactNode;
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
function render() {
  const shell = run(() => StoreShell({ children: null }), shellSlots);
  const boundary = find(shell, (e) => e.type === Fragment && e.key !== null)[0];
  if (!boundary) return;
  // Model React's keyed subtree reconciliation, running the real page hooks.
  if (boundary.key !== oldKey) {
    for (const cleanup of pageCleanups) cleanup?.();
    pageCleanups = [];
    pageSlots = [];
    oldKey = boundary.key;
  }
  const shellCleanups = hooks.cleanups;
  hooks.cleanups = pageCleanups;
  tree = run(TablesPageD, pageSlots);
  pageCleanups = hooks.cleanups;
  hooks.cleanups = shellCleanups;
}
let pageCleanups: (() => void)[] = [];
async function flush() {
  for (let i = 0; i < 8; i++) {
    render();
    await vi.runAllTimersAsync();
  }
  render();
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", "mock");
  vi.stubGlobal("window", new EventTarget());
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => values.set(k, v),
  });
  shellSlots.length = 0;
  pageSlots = [];
  oldKey = undefined;
  hooks.cleanups = [];
  hooks.effects = [];
  pageCleanups = [];
  await d.authMockAction("identity", "owner");
});
afterEach(() => {
  hooks.cleanups.forEach((c) => c?.());
  pageCleanups.forEach((c) => c?.());
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it.each(["INTERNAL", "toString", "__proto__"])(
  "unknown %s never exposes raw message",
  (code) => {
    const result = storePageMessage(
      new DataError(code as ErrorCode, "RAW-pg-detail tok=abc"),
    );
    expect(result).toBe("操作没有成功，请稍后再试");
    expect(result).not.toContain("RAW-pg-detail");
  },
);
it("non-data errors and NOT_IMPLEMENTED use staff messages", () => {
  expect(storePageMessage(new Error("RAW-pg-detail tok=abc"))).toBe(
    "操作没有成功，请稍后再试",
  );
  expect(storePageMessage(new DataError("NOT_IMPLEMENTED", "raw"))).toBe(
    "此功能即将开放",
  );
});
it("QR URL normalizes configured origin and ignores external origins in link data", () => {
  expect(tableQrUrl("/t/a", "https://site.test/base?q=1")).toBe(
    "https://site.test/t/a",
  );
  expect(
    tableQrUrl("https://evil.test/t/a?code=abc", "https://site.test/base"),
  ).toBe("https://site.test/t/a?code=abc");
  expect(tableQrUrl("//evil.test/t/a", undefined)).toBe(
    "http://localhost:3000/t/a",
  );
});
it("switching mock accounts to another store remounts tables and clears old QR preview", async () => {
  await flush();
  const sessionRead = d.getSession();
  await vi.runAllTimersAsync();
  const oldSession = await sessionRead;
  expect(JSON.stringify(tree)).toContain("A1");
  const preview = find(tree, (e) => e.props.children === "查看二维码")[0];
  (preview.props.onClick as () => void)();
  await flush();
  const { QrPrintD } = await import("../lib/ui/qr-d");
  expect(find(tree, (e) => e.type === QrPrintD)).toHaveLength(1);
  const previousKey = oldKey;
  await d.authMockAction("identity", "new");
  await flush();
  const pending = d.getSession();
  await vi.runAllTimersAsync();
  expect((await pending)?.store?.id).not.toBe(oldSession?.store?.id);
  expect(oldKey).not.toBe(previousKey);
  expect(find(tree, (e) => e.type === QrPrintD)).toHaveLength(0);
  expect(JSON.stringify(tree)).not.toContain("A1");
});
