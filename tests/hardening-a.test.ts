import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { DataError } from "../lib/data/types";
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

vi.mock("next/navigation", () => ({
  usePathname: () => "/store/live",
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock("next/link", () => ({ default: "link" }));
vi.mock("../lib/ui/common", () => ({
  Banner: "banner",
  ErrorState: "error",
  Modal: "modal",
  Skeleton: "skeleton",
}));
const api = vi.hoisted(() => ({
  getSession: vi.fn(),
  onSessionChange: vi.fn(),
  signOut: vi.fn(),
}));
vi.mock("../lib/data", () => api);
const { StoreShell } = await import("../lib/ui/store-shell");
let tree: ReturnType<typeof StoreShell>;
function render() {
  do {
    hooks.dirty = false;
    hooks.cursor = 0;
    tree = StoreShell({ children: null, storeStatus: "suspended" });
    hooks.effects.splice(0).forEach((effect) => effect());
  } while (hooks.dirty);
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
  const el = node as ReactElement<{ children?: ReactNode }>;
  return [
    ...(el.type === type ? [el as ReactElement<Record<string, unknown>>] : []),
    ...nodes(type, el.props.children ?? null),
  ];
}
beforeEach(() => {
  vi.resetAllMocks();
  hooks.slots = [];
  hooks.cleanups = [];
  hooks.effects = [];
  api.onSessionChange.mockReturnValue(() => {});
  api.getSession.mockResolvedValue({
    store: { name: "店", status: "active", is_profile_complete: true },
  });
});
afterEach(() => hooks.cleanups.forEach((cleanup) => cleanup?.()));
it.each([
  new DataError("NOT_IMPLEMENTED", "secret"),
  new Error("secret"),
  new DataError("toString" as never, "secret"),
])(
  "renders only generic shell errors for unknown failures: %s",
  async (error) => {
    api.getSession.mockRejectedValueOnce(error);
    render();
    await flush();
    expect(nodes("error")[0].props.message).toBe("操作没有成功，请稍后再试");
  },
);
it("sanitizes sign-out failures and renders the suspended banner", async () => {
  render();
  await flush();
  expect(nodes("banner")[0].props.children).toBe(
    "店铺已被平台停用，请联系平台",
  );
  api.signOut.mockRejectedValueOnce(new Error("secret"));
  (
    nodes("button").find((node) => node.props.children === "退出登录")!.props
      .onClick as () => void
  )();
  await flush();
  expect(nodes("error")[0].props.message).toBe("操作没有成功，请稍后再试");
});
