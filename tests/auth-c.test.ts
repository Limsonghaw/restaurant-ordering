import { afterEach, describe, expect, it, vi } from "vitest";
import { safeNext } from "../lib/auth/safe-next";
import { evaluateAccess, toAuthState, type AuthState } from "../lib/auth/guard";
import { normalizePhone, validPassword } from "../lib/auth/validation";
import { parseMoneyInput } from "../lib/format";
import type { MyContext } from "../lib/data/types";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("安全跳转", () => {
  it.each([
    null,
    "//evil.invalid/store",
    "\\store",
    "https://evil.invalid/store",
    "javascript:alert(1)",
    "/admin",
    "/storehouse",
    "/store/%2f%2fevil.invalid",
    "/store/../admin",
    " /store",
  ])("拒绝 %s", (value) => expect(safeNext(value)).toBe("/store"));
  it.each([
    "/reset-password",
    "/set-password",
    "/store/menu?filter=hidden",
    "https://placeholder.invalid/reset-password",
  ])("允许本站 %s", (value) =>
    expect(safeNext(value)).toBe(
      value.replace("https://placeholder.invalid", ""),
    ),
  );
  it("浏览器使用当前 origin", () => {
    vi.stubGlobal("window", {
      location: { origin: "https://preview.invalid" },
    });
    expect(safeNext("https://preview.invalid/store/menu")).toBe("/store/menu");
    expect(safeNext("https://placeholder.invalid/store/menu")).toBe("/store");
  });
});
const states: AuthState[] = [
  { kind: "anonymous" },
  { kind: "needs_mfa" },
  { kind: "platform_admin" },
  { kind: "no_store" },
  { kind: "needs_password" },
  {
    kind: "ready",
    storeId: "a",
    storeStatus: "suspended",
    isProfileComplete: false,
  },
];
const targets = [
  "/login?next=%2Fstore%2Fmenu",
  "/admin/mfa",
  "/admin",
  "/verify",
  "/set-password?next=%2Fstore%2Fmenu",
  true,
];
describe("§21.4 全部守卫格", () => {
  const rows: [string, (string | boolean)[]][] = [
    ["/store/menu", targets],
    [
      "/store",
      [
        "/login?next=%2Fstore",
        "/admin/mfa",
        "/admin",
        "/verify",
        "/set-password?next=%2Fstore",
        true,
      ],
    ],
    [
      "/admin/mfa",
      [
        "/login?next=%2Fstore",
        true,
        "/admin",
        "/verify",
        "/set-password?next=%2Fstore",
        "/store",
      ],
    ],
    [
      "/admin/stores",
      [
        "/login?next=%2Fstore",
        "/admin/mfa",
        true,
        "/verify",
        "/set-password?next=%2Fstore",
        "/store",
      ],
    ],
    [
      "/admin",
      [
        "/login?next=%2Fstore",
        "/admin/mfa",
        true,
        "/verify",
        "/set-password?next=%2Fstore",
        "/store",
      ],
    ],
    [
      "/set-password",
      [
        "/login?next=%2Fset-password",
        "/admin/mfa",
        "/admin",
        "/verify",
        true,
        true,
      ],
    ],
    [
      "/reset-password",
      [
        "/login?next=%2Freset-password",
        "/admin/mfa",
        "/admin",
        "/verify",
        true,
        true,
      ],
    ],
    [
      "/verify",
      [
        true,
        "/admin/mfa",
        "/admin",
        true,
        "/set-password?next=%2Fstore",
        "/store",
      ],
    ],
    ...["/login", "/register", "/forgot-password", "/auth/confirm"].map(
      (p) => [p, [true, true, true, true, true, true]] as [string, boolean[]],
    ),
  ];
  for (const [path, results] of rows)
    states.forEach((s, i) =>
      it(`${path} × ${s.kind}`, () =>
        expect(evaluateAccess(path, s)).toEqual(
          results[i] === true
            ? { allow: true }
            : { allow: false, to: results[i] },
        )),
    );
  it("公共路径不拦截", () =>
    expect(evaluateAccess("/t/demo-a1", states[0])).toEqual({ allow: true }));
  it("MyContext 优先级", () => {
    const base: MyContext = {
      user_id: "x",
      platform_role: "merchant",
      aal: "aal1",
      password_set: true,
      password_set_at: "now",
      member_role: "owner",
      store: {
        id: "a",
        slug: "a",
        name: "店",
        logo_path: null,
        status: "active",
        status_changed_at: null,
        is_accepting_orders: true,
        is_profile_complete: false,
      },
    };
    expect(toAuthState(null).kind).toBe("anonymous");
    expect(toAuthState({ ...base, platform_role: "platform_admin" }).kind).toBe(
      "needs_mfa",
    );
    expect(
      toAuthState({ ...base, platform_role: "platform_admin", aal: "aal2" })
        .kind,
    ).toBe("platform_admin");
    expect(toAuthState({ ...base, store: null }).kind).toBe("no_store");
    expect(toAuthState({ ...base, password_set_at: null }).kind).toBe(
      "needs_password",
    );
    expect(toAuthState(base)).toEqual({
      kind: "ready",
      storeId: "a",
      storeStatus: "active",
      isProfileComplete: false,
    });
  });
});
describe("输入边界", () => {
  it.each([
    ["0", 0],
    ["9999.99", 999999],
    ["12.5", 1250],
    ["-1", null],
    ["10000", null],
    ["1.001", null],
    ["1e3", null],
    ["", null],
    ["12.", null],
  ])("RM %s", (s, n) => expect(parseMoneyInput(s as string)).toBe(n));
  it("密码长度、字母、数字", () => {
    expect(validPassword("demo-pass-123")).toBe(true);
    for (const p of ["short1", "abcdefgh", "12345678", "a".repeat(72) + "1"])
      expect(validPassword(p)).toBe(false);
  });
  it("MY 手机解析与国家白名单", () => {
    expect(normalizePhone("012-000 0001")).toBe("+60120000001");
    expect(normalizePhone("12-345 6789")).toBe("+60123456789");
    expect(() => normalizePhone("123")).toThrow("请输入正确的手机号");
    expect(() => normalizePhone("+6591234567")).toThrow("暂不支持");
  });
});

// 注册/找回发送的公开结果一致；未知错误仍失败，不能读原始 message。
it("账号已存在类错误与成功发送返回相同结果，注册和找回共用同一分支", async () => {
  const { sendWithoutEnumeration } = await import("../lib/ui/auth-c");
  const { DataError } = await import("../lib/data/types");
  const success = await sendWithoutEnumeration(async () => ({ sent: true }));
  for (const code of [
    "USER_ALREADY_EXISTS",
    "USER_ALREADY_REGISTERED",
    "EMAIL_EXISTS",
    "PHONE_EXISTS",
  ]) {
    const error = new DataError(
      code as import("../lib/data/types").ErrorCode,
      "private",
    );
    Object.defineProperty(error, "message", {
      get() {
        throw Error("must not read message");
      },
    });
    expect(
      await sendWithoutEnumeration(async () => {
        throw error;
      }),
    ).toBe(success);
  }
  await expect(
    sendWithoutEnumeration(async () => {
      throw new DataError("NETWORK", "private");
    }),
  ).rejects.toMatchObject({ code: "NETWORK" });
});
