import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
class StorageStub {
  values = new Map<string, string>();
  getItem(k: string) {
    return this.values.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.values.set(k, v);
  }
  removeItem(k: string) {
    this.values.delete(k);
  }
}
async function finish<T>(promise: Promise<T>) {
  const guarded = promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await vi.runAllTimersAsync();
  const r = await guarded;
  if ("error" in r) throw r.error;
  return r.value;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", "mock");
  const win = new EventTarget();
  Object.assign(win, { location: { origin: "https://placeholder.invalid" } });
  vi.stubGlobal("window", win);
  vi.stubGlobal("localStorage", new StorageStub());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
const contact = { email: "fresh@demo.test" };
const captcha = () => ({ captcha_token: crypto.randomUUID() });
async function data() {
  vi.resetModules();
  return import("../lib/data");
}
describe("PR-C 认证合约", () => {
  it("默认匿名，演示密码与 MY 手机登录，错误账号不泄漏", async () => {
    const d = await data();
    expect(await finish(d.getSession())).toBeNull();
    await finish(
      d.signInWithPassword({
        email: "owner@demo.test",
        password: "demo-pass-123",
        ...captcha(),
      }),
    );
    expect((await finish(d.getSession()))?.store?.id).toBe("store-0");
    await finish(d.signOut());
    await finish(
      d.signInWithPassword({
        phone: "+60120000001",
        password: "demo-pass-123",
        ...captcha(),
      }),
    );
    for (const email of [
      "missing@demo.test",
      "nopw@demo.test",
      "unverified@demo.test",
    ])
      await expect(
        finish(
          d.signInWithPassword({
            email,
            password: "demo-pass-123",
            ...captcha(),
          }),
        ),
      ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });
  it("链接手动确认、一次性、设密码后保留会话，不存明文密码", async () => {
    const d = await data();
    const cap = captcha();
    await finish(d.sendSignUpOtp(contact, cap));
    expect(await finish(d.getSession())).toBeNull();
    const mail = (await d.getAuthMockSnapshot()).mails[0];
    const input = {
      token_hash: mail.id,
      type: "email",
      next: "https://placeholder.invalid/store/menu",
    };
    expect(await finish(d.confirmEmailLink(input))).toEqual({
      next: "/store/menu",
    });
    expect((await finish(d.getSession()))?.password_set_at).toBeNull();
    await finish(d.setPassword("new-demo-456"));
    expect((await finish(d.getSession()))?.password_set).toBe(true);
    await expect(finish(d.confirmEmailLink(input))).rejects.toMatchObject({
      code: "RESET_LINK_INVALID",
    });
    await expect(
      finish(d.sendSignUpOtp({ email: "another@demo.test" }, cap)),
    ).rejects.toMatchObject({ code: "CAPTCHA_FAILED" });
    expect(localStorage.getItem("ro-mock:auth-c-v1")).not.toContain(
      "new-demo-456",
    );
  });
  it("旧账号和新账号发送结果相同，限流和不支持 type，过期链接", async () => {
    const d = await data();
    await finish(d.sendSignUpOtp({ email: "owner@demo.test" }, captcha()));
    await finish(d.sendSignUpOtp(contact, captcha()));
    await expect(
      finish(d.sendSignUpOtp(contact, captcha())),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    const mail = (await d.getAuthMockSnapshot()).mails[1];
    await expect(
      finish(
        d.confirmEmailLink({
          token_hash: mail.id,
          type: "sms",
          next: "/store",
        }),
      ),
    ).rejects.toMatchObject({ code: "RESET_LINK_INVALID" });
    await d.authMockAction("expire-mail", mail.id);
    await expect(
      finish(
        d.confirmEmailLink({
          token_hash: mail.id,
          type: "email",
          next: "/store",
        }),
      ),
    ).rejects.toMatchObject({ code: "RESET_LINK_INVALID" });
  });
  it("短信第五次错误后正确码也失效，重发后可验证", async () => {
    const d = await data();
    const phone = "+60123456789";
    await finish(d.sendSignUpOtp({ phone }, captcha()));
    for (let n = 0; n < 5; n++)
      await expect(
        finish(d.verifySmsOtp({ phone, token: "000000" })),
      ).rejects.toMatchObject({ code: "OTP_INVALID" });
    await expect(
      finish(d.verifySmsOtp({ phone, token: "123456" })),
    ).rejects.toMatchObject({ code: "OTP_INVALID" });
    vi.advanceTimersByTime(60000);
    await finish(d.sendSignUpOtp({ phone }, captcha()));
    await finish(d.verifySmsOtp({ phone, token: "123456" }));
    expect((await finish(d.getSession()))?.user.phone).toBe(phone);
    expect(localStorage.getItem("ro-mock:auth-c-v1")).not.toContain('123456"');
  });
  it("重设密码撤销旧密码，五分钟期限与错误注入", async () => {
    const d = await data();
    await finish(
      d.requestPasswordReset({ email: "owner@demo.test" }, captcha()),
    );
    const mail = (await d.getAuthMockSnapshot()).mails[0];
    await finish(
      d.confirmEmailLink({
        token_hash: mail.id,
        type: "email",
        next: "/reset-password",
      }),
    );
    await d.authMockAction("fail:password", "FORBIDDEN");
    await expect(
      finish(d.setPassword("updated-demo-123")),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await finish(d.setPassword("updated-demo-123"));
    await expect(
      finish(d.setPassword("updated-demo-123")),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await d.authMockAction("expire-verification");
    await expect(
      finish(d.setPassword("another-demo-123")),
    ).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    await finish(d.signOut());
    await expect(
      finish(
        d.signInWithPassword({
          email: "owner@demo.test",
          password: "demo-pass-123",
          ...captcha(),
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
    await finish(
      d.signInWithPassword({
        email: "owner@demo.test",
        password: "updated-demo-123",
        ...captcha(),
      }),
    );
  });
});
describe("PR-C 菜单与拉黑合约", () => {
  it("分类隐藏、改价、软删与 P1 共用数据，排序持久", async () => {
    const d = await data();
    await d.authMockAction("identity", "owner");
    const menu = await finish(d.getMenuForStore());
    const category = menu.categories[0];
    const first = menu.items.find((i) => i.category_id === category.id)!;
    await expect(finish(d.deleteCategory(category.id))).rejects.toMatchObject({
      code: "CATEGORY_NOT_EMPTY",
    });
    await finish(d.setCategoryHidden(category.id, true));
    expect(
      (await finish(d.getTableMenu("demo-a1"))).items.some(
        (i) => i.category_id === category.id,
      ),
    ).toBe(false);
    await finish(d.setCategoryHidden(category.id, false));
    await finish(d.updateItem(first.id, { ...first, price_cents: 999 }));
    expect(
      (await finish(d.getTableMenu("demo-a1"))).items.find(
        (i) => i.id === first.id,
      )?.price_cents,
    ).toBe(999);
    await finish(
      d.reorderCategories(menu.categories.map((c) => c.id).reverse()),
    );
    expect((await finish(d.getMenuForStore())).categories[0].id).toBe(
      menu.categories.at(-1)!.id,
    );
    await expect(
      finish(d.reorderCategories([category.id])),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await finish(d.deleteItem(first.id));
    expect(
      (await finish(d.getTableMenu("demo-a1"))).items.some(
        (i) => i.id === first.id,
      ),
    ).toBe(false);
    expect((await finish(d.getTableBill("demo-a1"))).view).toBe("bill");
  });
  it("无资料账号菜单为空，停用店铺全部写操作被拒", async () => {
    const d = await data();
    await d.authMockAction("identity", "new");
    expect((await finish(d.getMenuForStore())).categories).toHaveLength(0);
    expect((await finish(d.getSession()))?.store?.is_profile_complete).toBe(
      false,
    );
    await d.authMockAction("profile");
    expect((await finish(d.getSession()))?.store?.is_profile_complete).toBe(
      true,
    );
    await d.authMockAction("identity", "disabled");
    expect((await finish(d.getMenuForStore())).items.length).toBeGreaterThan(0);
    await expect(finish(d.createCategory("新分类"))).rejects.toMatchObject({
      code: "STORE_SUSPENDED",
    });
    await expect(finish(d.unblockClient("any"))).rejects.toMatchObject({
      code: "STORE_SUSPENDED",
    });
  });
  it("无店账号完成设置，未验证账号清理后可重发", async () => {
    const d = await data();
    await d.authMockAction("identity", "nostore");
    expect((await finish(d.getSession()))?.store).toBeNull();
    expect((await finish(d.ensureMyStore())).created).toBe(true);
    expect((await finish(d.getSession()))?.store).not.toBeNull();
    await finish(d.sendSignUpOtp(contact, captcha()));
    await d.authMockAction("cleanup");
    vi.advanceTimersByTime(60000);
    await finish(d.sendSignUpOtp(contact, captcha()));
  });
  it("拉黑只返回安全列、过期不可见、当前设备拒单与解除", async () => {
    const d = await data();
    await d.authMockAction("identity", "owner");
    const initial = await finish(d.listBlockedClients());
    expect(initial).toHaveLength(1);
    expect(JSON.stringify(initial)).not.toMatch(/device_id|value_hash/);
    await d.blocksMockAction(false);
    const rows = await finish(d.listBlockedClients());
    expect(rows).toHaveLength(2);
    const body = {
      client_request_id: crypto.randomUUID(),
      items: [
        {
          item_id: "store-0-item-0",
          quantity: 1,
          unit_price_cents: 1250,
          note: "",
        },
      ],
    };
    await expect(finish(d.placeOrder("demo-a2", body))).rejects.toMatchObject({
      code: "DEVICE_BLOCKED",
    });
    await finish(
      d.unblockClient(rows.find((r) => r.source_order === null)!.id),
    );
    expect((await finish(d.placeOrder("demo-a2", body))).order.status).toBe(
      "new",
    );
    await d.blocksMockAction(true);
    expect(await finish(d.listBlockedClients())).toHaveLength(0);
  });
});

describe("PR-C 过期与权限边界", () => {
  it("邮件 15 分钟失效、验证码 10 分钟失效，刷新模块不能重用 captcha", async () => {
    const d = await data();
    const cap = captcha();
    await finish(d.sendSignUpOtp(contact, cap));
    const mail = (await d.getAuthMockSnapshot()).mails[0];
    vi.advanceTimersByTime(900001);
    await expect(
      finish(
        d.confirmEmailLink({
          token_hash: mail.id,
          type: "email",
          next: "/store",
        }),
      ),
    ).rejects.toMatchObject({ code: "RESET_LINK_INVALID" });
    const again = await data();
    await expect(
      finish(again.sendSignUpOtp({ email: "other@demo.test" }, cap)),
    ).rejects.toMatchObject({ code: "CAPTCHA_FAILED" });
    await finish(again.sendSignUpOtp({ phone: "+60123456789" }, captcha()));
    vi.advanceTimersByTime(600001);
    await expect(
      finish(again.verifySmsOtp({ phone: "+60123456789", token: "123456" })),
    ).rejects.toMatchObject({ code: "OTP_INVALID" });
  });
  it("上传按字节拒绝伪装文件和超限文件，R9 取消并拉黑而不改历史明细", async () => {
    const d = await data();
    await d.authMockAction("identity", "owner");
    await expect(
      finish(
        d.uploadItemImage(
          new File(["GIF89a"], "fake.png", { type: "image/png" }),
          () => {},
        ),
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_FILE_TYPE" });
    await expect(
      finish(
        d.uploadItemImage(
          new File([new Uint8Array(2097153)], "big.jpg", {
            type: "image/jpeg",
          }),
          () => {},
        ),
      ),
    ).rejects.toMatchObject({ code: "FILE_TOO_LARGE" });
    expect(await finish(d.blockClientFromOrder("store-0-order-2"))).toEqual({
      blocked: true,
      cancelled: true,
    });
    const bill = await finish(d.getTableBill("demo-a1"));
    if (bill.view !== "bill") throw Error("missing bill");
    const order = bill.orders.find((o) => o.id === "store-0-order-2");
    expect(order?.status).toBe("cancelled");
    expect(order?.lines[0].item_name).toBeTruthy();
    await expect(
      finish(d.blockClientFromOrder("store-0-order-0")),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

it("设置密码只保留当前模拟会话，撤销另一个已加载的会话", async () => {
  const first = await data();
  await finish(
    first.signInWithPassword({
      email: "owner@demo.test",
      password: "demo-pass-123",
      ...captcha(),
    }),
  );
  const second = await data();
  await second.authMockAction("identity", "owner");
  await finish(second.setPassword("new-session-demo-123"));
  expect(await finish(first.getSession())).toBeNull();
  expect((await finish(second.getSession()))?.user.email).toBe(
    "owner@demo.test",
  );
});

it("并发复用同一 captcha 也只能发送一次", async () => {
  const d = await data();
  const cap = captcha();
  const calls = Promise.allSettled([
    d.sendSignUpOtp({ email: "one@demo.test" }, cap),
    d.sendSignUpOtp({ email: "two@demo.test" }, cap),
  ]);
  await vi.runAllTimersAsync();
  const result = await calls;
  expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const rejected = result.find((r) => r.status === "rejected");
  expect(rejected?.status === "rejected" && rejected.reason.code).toBe(
    "CAPTCHA_FAILED",
  );
});
