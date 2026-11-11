import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { DataError, type ErrorCode } from "../lib/data/types";
import { errorMessage } from "../lib/format";
import { authError } from "../lib/ui/auth-c";
import {
  authFieldErrors,
  menuFieldErrors,
  uploadError,
} from "../lib/ui/error-messages";
import { imageUrl } from "../lib/data/supabase/menu";
import { logoUrl } from "../lib/ui/customer";

afterEach(() => vi.unstubAllEnvs());
it.each(["NOT_IMPLEMENTED", "toString", "constructor", "__proto__", "UNKNOWN"])(
  "未知错误 %s 不读取原始 message",
  (code) => {
    const error = new DataError(
      code as ErrorCode,
      "private SQL User already registered",
    );
    Object.defineProperty(error, "message", {
      get() {
        throw Error("message must not be read");
      },
    });
    for (const format of [errorMessage, authError, uploadError]) {
      expect(format(error)).toBe("操作没有成功，请稍后再试");
      expect(format(new Error("private"))).toBe("操作没有成功，请稍后再试");
    }
  },
);
it("保留白名单文案及固定字段提示", () => {
  expect(errorMessage(new DataError("TABLE_INVALID", "private"))).toBe(
    "这个二维码已失效，请联系店员",
  );
  expect(
    authError(new DataError("INVALID_CREDENTIALS", "User already registered")),
  ).toBe("账号或密码不正确");
  expect(
    authError(new DataError("INVALID_CREDENTIALS", "User not found")),
  ).toBe("账号或密码不正确");
  expect(
    authFieldErrors(
      new DataError("VALIDATION_FAILED", "private", { field: "account" }),
    ),
  ).toEqual({ account: "请输入正确的邮箱或手机号" });
  expect(
    menuFieldErrors(
      new DataError("VALIDATION_FAILED", "private", { field: "description" }),
    ),
  ).toEqual({ description: "介绍最多 300 字" });
  expect(
    menuFieldErrors(
      new DataError("VALIDATION_FAILED", "private", { field: "__proto__" }),
    ),
  ).toEqual({});
  expect(uploadError(new DataError("FILE_TOO_LARGE", "private"))).toBe(
    "图片不能超过 2 MB",
  );
});
it.each([
  "https://outside.invalid/logo.png",
  "http://outside.invalid/logo.png",
  "//outside.invalid/logo.png",
  "data:image/webp;base64,abc",
  "../logo.png",
  "store/logo/../../logo.png",
])("Logo 拒绝 %s", (path) => {
  vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", "supabase");
  expect(imageUrl(path)).toBeNull();
  expect(logoUrl(path)).toBe("/mock/logo.svg");
});
it("Storage URL 仅从配置拼装，缺失配置不会抛错", () => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://placeholder.invalid");
  expect(imageUrl("store-id/logo/image.webp")).toBe(
    "https://placeholder.invalid/storage/v1/object/public/menu-images/store-id/logo/image.webp",
  );
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
  expect(imageUrl("store-id/logo/image.webp")).toBeNull();
});
it("顾客错误出口和间接调用者使用白名单；R9 注释完整", () => {
  for (const file of ["customer", "auth-c", "menu-c"])
    expect(readFileSync(`lib/ui/${file}.tsx`, "utf8")).not.toMatch(
      /\b(?:e|error)\.message/,
    );
  for (const file of ["access-c", "blocks-c", "menu-c"])
    expect(readFileSync(`lib/ui/${file}.tsx`, "utf8")).toContain(
      "errorMessage(",
    );
  const comment = readFileSync("lib/data/supabase/blocks-c.ts", "utf8");
  for (const marker of [
    "ORDER_BILL_CLOSED",
    "VALIDATION_FAILED",
    "{ blocked: 1, cancelled: false }",
    "{ blocked: number, cancelled: boolean }",
  ])
    expect(comment).toContain(marker);
});

const authProbe = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  send: vi.fn<() => Promise<void>>(),
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
}));
vi.mock("react", async (original) => {
  const real = await original<typeof import("react")>();
  return {
    ...real,
    useEffect: () => {},
    useState: (initial: unknown) => {
      const index = authProbe.cursor++;
      if (!(index in authProbe.slots)) authProbe.slots[index] = initial;
      return [
        authProbe.slots[index],
        (value: unknown) => {
          authProbe.slots[index] =
            typeof value === "function" ? value(authProbe.slots[index]) : value;
        },
      ];
    },
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => authProbe.router,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("../lib/data", async (original) => ({
  ...(await original<typeof import("../lib/data")>()),
  sendSignUpOtp: () => authProbe.send(),
  requestPasswordReset: () => authProbe.send(),
  signInWithPassword: () => authProbe.send(),
}));
import { AuthPage } from "../lib/ui/auth-c";
import { Captcha } from "../lib/ui/captcha";
import type { ReactElement, ReactNode } from "react";
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!node || typeof node !== "object" || !("props" in node)) return [];
  const element = node as ReactElement<Record<string, unknown>>;
  return [element, ...elements(element.props.children as ReactNode)];
}
it.each(["register", "forgot-password"] as const)(
  "%s 已存在错误与成功发送的界面完全相同",
  async (mode) => {
    const storage = new Map();
    vi.stubGlobal("sessionStorage", {
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    async function submit(code?: string) {
      authProbe.slots = [];
      authProbe.send.mockImplementation(async () => {
        if (code)
          throw new DataError(
            code as ErrorCode,
            "User already registered private",
          );
      });
      const render = () => {
        authProbe.cursor = 0;
        return AuthPage({ mode });
      };
      let nodes = elements(render());
      (
        nodes.find((n) => n.type === "input" && n.props.type === "email")!.props
          .onChange as (e: unknown) => void
      )({ target: { value: "person@placeholder.invalid" } });
      (
        nodes.find((n) => n.type === Captcha)!.props.onToken as (
          token: string,
        ) => void
      )("placeholder-token");
      nodes = elements(render());
      expect(nodes.find((n) => n.type === Captcha)?.props.action).toBe(
        mode === "register" ? "signup" : "recover",
      );
      (
        nodes.find((n) => n.type === "form")!.props.onSubmit as (
          e: unknown,
        ) => void
      )({ preventDefault() {} });
      for (let i = 0; i < 10; i++) await Promise.resolve();
      const result = render();
      return JSON.stringify(result, (key, value) =>
        key === "type"
          ? typeof value === "string"
            ? value
            : "component"
          : key === "_owner"
            ? undefined
            : value,
      );
    }
    try {
      const success = await submit();
      expect(success).toContain("邮件已发出");
      expect(success).not.toContain("User already registered");
      for (const code of [
        "USER_ALREADY_EXISTS",
        "EMAIL_EXISTS",
        "PHONE_EXISTS",
      ])
        expect(await submit(code)).toBe(success);
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

it.each([
  ["login", "login"],
  ["verify", "resend"],
] as const)("%s 页面传递固定验证码 action", (mode, action) => {
  authProbe.slots = [];
  authProbe.cursor = 0;
  expect(
    elements(AuthPage({ mode })).find((n) => n.type === Captcha)?.props.action,
  ).toBe(action);
  expect(readFileSync("lib/ui/customer.tsx", "utf8")).toMatch(
    /<Captcha\s+action="place_order"/,
  );
});
