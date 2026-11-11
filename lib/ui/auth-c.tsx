"use client";
import Link from "next/link";
import { routes } from "../routes";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { authFieldErrors } from "./error-messages";
import { Captcha } from "./captcha";
import {
  getSession,
  onSessionChange,
  sendSignUpOtp,
  requestPasswordReset,
  confirmEmailLink,
  verifySmsOtp,
  signInWithPassword,
  setPassword,
  ensureMyStore,
  signOut,
  DataError,
  type Session,
  type AuthContact,
} from "../data";
import { safeNext } from "../auth/safe-next";
import { normalizePhone, validPassword } from "../auth/validation";
import { evaluateAccess, toAuthState } from "../auth/guard";
export const platformName = "茶餐 · 店家";
export const cleanupHint = "注册后超过 24 小时未完成验证会被清理，需要重新注册";
export const resetDescriptions = {
  email:
    "我们会给这个邮箱发一封邮件，点里面的链接后设置新密码。如果这个邮箱还没有账号，点链接后会用它开通一个新账号和店铺（店名之后在店铺设置里填写），需要先设置密码；没点链接的话 24 小时后自动作废。",
  phone:
    "我们会给这个号码发一条 6 位验证码，输入后设置新密码。如果这个号码还没有账号，输入验证码后会用它开通一个新账号和店铺（店名之后在店铺设置里填写），需要先设置密码；没输入的话 24 小时后自动作废。",
};
export function authError(e: unknown) {
  const messages: Record<string, string> = {
    PHONE_NOT_SUPPORTED: "暂不支持这个国家或地区的手机号，请改用邮箱",
    SMS_SEND_FAILED: "短信发送失败，请改用邮箱或稍后再试",
    CAPTCHA_FAILED: "人机验证失败，请重试",
    CAPTCHA_REQUIRED: "人机验证失败，请重试",
    RATE_LIMITED: "请稍后再试",
    INVALID_CREDENTIALS: "账号或密码不正确",
    EMAIL_NOT_CONFIRMED: "请先完成验证",
    PHONE_NOT_CONFIRMED: "请先完成验证",
    NETWORK: "网络出错，请重试",
    FORBIDDEN: "请求被拒绝，请刷新页面后重试",
    UNSUPPORTED_MEDIA_TYPE: "请求被拒绝，请刷新页面后重试",
    WEAK_PASSWORD: "密码至少 8 位，需包含字母和数字",
    REAUTH_REQUIRED: "为了安全，请重新验证",
    OTP_INVALID: "验证码不正确或已失效，请重新输入",
    RESET_LINK_INVALID: "链接已失效",
    VALIDATION_FAILED: "请检查填写的内容",
    UNAUTHENTICATED: "请重新登录",
  };
  return e instanceof DataError && Object.hasOwn(messages, e.code)
    ? messages[e.code]
    : "操作没有成功，请稍后再试";
}

// 已存在的账号与发送成功进入同一个界面分支，不暴露账号是否存在。
export async function sendWithoutEnumeration(send: () => Promise<unknown>) {
  try {
    await send();
  } catch (error) {
    if (
      !(error instanceof DataError) ||
      ![
        "USER_ALREADY_EXISTS",
        "USER_ALREADY_REGISTERED",
        "EMAIL_EXISTS",
        "PHONE_EXISTS",
      ].includes(error.code)
    )
      throw error;
  }
}
export function AuthPage({
  mode,
}: {
  mode:
    | "login"
    | "register"
    | "forgot-password"
    | "verify"
    | "confirm"
    | "set-password"
    | "reset-password";
}) {
  const router = useRouter();
  const query = useSearchParams();
  const next = safeNext(query.get("next"));
  const [kind, setKind] = useState<"email" | "phone">("email");
  const [account, setAccount] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPass] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [show, setShow] = useState(false);
  const [otp, setOtp] = useState("");
  const [attempts, setAttempts] = useState(0);
  const [token, setToken] = useState("");
  const [reset, setReset] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [sent, setSent] = useState(false);
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [errorCode, setErrorCode] = useState("");
  const [ctx, setCtx] = useState<Session | null>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const passwordMode = mode === "set-password" || mode === "reset-password";
  const forgot = mode === "forgot-password";
  const verify = mode === "verify";
  const title = passwordMode
    ? mode === "set-password"
      ? "设置登录密码"
      : "重设密码"
    : mode === "confirm"
      ? next === routes.resetPassword
        ? "继续重设密码"
        : "完成邮箱验证"
      : verify
        ? "短信验证"
        : forgot
          ? "忘记密码"
          : mode === "register"
            ? "免费注册"
            : "登录";
  useEffect(() => {
    let active = true;
    void getSession()
      .then((s) => {
        if (active) setCtx(s);
      })
      .catch((e) => {
        if (active) setError(authError(e));
      });
    let stop: (() => void) | undefined;
    try {
      stop = onSessionChange((s) => {
        if (active) setCtx(s);
      });
    } catch (e) {
      Promise.resolve().then(() => setError(authError(e)));
    }
    Promise.resolve().then(() => {
      if (!active) return;
      const saved = sessionStorage.getItem("auth_contact");
      if (saved) {
        setAccount(saved);
        setKind(saved.startsWith("+") ? "phone" : "email");
      }
      if (verify) {
        try {
          const value = normalizePhone(
            sessionStorage.getItem("verify_phone") || "",
          );
          setPhone(value);
          setSeconds(60);
        } catch {
          /* New tab: ask for number. */
        }
      }
    });
    return () => {
      active = false;
      stop?.();
    };
  }, [verify]);
  useEffect(() => {
    if (seconds <= 0) return;
    const timer = setTimeout(() => setSeconds((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [seconds]);
  useEffect(() => {
    if (ctx === undefined) return;
    if (passwordMode) {
      const decision = evaluateAccess(
        mode === "set-password" ? routes.setPassword : routes.resetPassword,
        toAuthState(ctx),
      );
      if (!decision.allow) router.replace(decision.to);
    }
    if ((mode === "login" || mode === "register") && ctx?.password_set_at) {
      router.replace(
        ctx.platform_role === "platform_admin"
          ? routes.admin
          : next === routes.store
            ? routes.storeLive
            : next,
      );
    }
    if (verify && ctx?.platform_role === "platform_admin")
      router.replace(routes.admin);
    else if (verify && ctx?.store && !busy) {
      if (!ctx.password_set_at)
        router.replace(
          `${routes.setPassword}?next=${encodeURIComponent(next)}`,
        );
      else
        router.replace(next === routes.resetPassword ? next : routes.storeLive);
    }
  }, [ctx, mode, next, passwordMode, router, verify, busy]);
  async function done(destination = next) {
    const s = await getSession();
    if (s?.platform_role === "platform_admin")
      return router.replace(routes.admin);
    if (!s?.store) return router.replace(routes.verify);
    if (!s.password_set_at)
      return router.replace(
        `${routes.setPassword}?next=${encodeURIComponent(safeNext(destination))}`,
      );
    router.replace(
      destination === routes.store ? routes.storeLive : safeNext(destination),
    );
  }
  function contact(): AuthContact {
    if (kind === "phone") return { phone: normalizePhone(account) };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account) || account.length > 254)
      throw new DataError("VALIDATION_FAILED", "请输入正确的邮箱");
    return { email: account.trim() };
  }
  function handleError(e: unknown) {
    setError(authError(e));
    if (e instanceof DataError) {
      setErrorCode(e.code);
      if (e.code === "VALIDATION_FAILED" && !passwordMode)
        setFieldErrors(authFieldErrors(e));
      if (e.code === "WEAK_PASSWORD")
        setFieldErrors({ password: "密码至少 8 位，需包含字母和数字" });
      if (e.code === "PHONE_NOT_SUPPORTED" || e.code === "SMS_SEND_FAILED")
        setKind("email");
      if (e.code === "RATE_LIMITED") setSeconds(e.retryAfterSeconds || 60);
    }
  }
  async function send() {
    setBusy(true);
    setError("");
    setErrorCode("");
    try {
      const c = verify && phone ? { phone } : contact();
      await sendWithoutEnumeration(() =>
        (forgot || (verify && next === routes.resetPassword)
          ? requestPasswordReset
          : sendSignUpOtp)(c, { captcha_token: token }),
      );
      sessionStorage.setItem("auth_contact", c.email ?? c.phone!);
      setSeconds(60);
      setSent(true);
      setAttempts(0);
      if (c.phone) {
        sessionStorage.setItem("verify_phone", c.phone);
        if (verify) {
          setPhone(c.phone);
          setError("验证码已重新发送");
        } else
          router.push(
            `${routes.verify}?next=${encodeURIComponent(forgot ? routes.resetPassword : routes.store)}`,
          );
      }
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
      setToken("");
      setReset((r) => r + 1);
    }
  }
  async function login() {
    setBusy(true);
    setError("");
    setErrorCode("");
    try {
      await signInWithPassword({
        ...contact(),
        password,
        captcha_token: token,
      });
      await done();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
      setToken("");
      setReset((r) => r + 1);
    }
  }
  async function verifyCode(value: string) {
    if (busy || attempts >= 5 || (errorCode === "RATE_LIMITED" && seconds > 0))
      return;
    setBusy(true);
    setError("");
    setErrorCode("");
    try {
      await verifySmsOtp({ phone, token: value });
      await done();
    } catch (e) {
      handleError(e);
      setOtp("");
      if (e instanceof DataError && e.code === "OTP_INVALID") {
        setAttempts((a) => a + 1);
        if (attempts >= 4) setError("这个验证码已失效，请重新发送");
      }
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    setBusy(true);
    setError("");
    setErrorCode("");
    try {
      if (
        !query.get("token_hash") ||
        !["email", "recovery", "email_change"].includes(query.get("type") || "")
      )
        throw new DataError("RESET_LINK_INVALID", "链接已失效");
      const result = await confirmEmailLink({
        token_hash: query.get("token_hash") || "",
        type: query.get("type") || "",
        next,
      });
      await done(result.next);
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    const fields: Record<string, string> = {};
    if (!validPassword(password))
      fields.password = "密码至少 8 位，需包含字母和数字";
    if (password !== confirmation) fields.confirmation = "两次输入的密码不一致";
    setFieldErrors(fields);
    if (Object.keys(fields).length) return;
    setBusy(true);
    setError("");
    setErrorCode("");
    try {
      await setPassword(password);
      setSuccess(mode === "reset-password" ? "密码已更新" : "密码已设置");
      router.replace(
        next === routes.store || next === routes.resetPassword
          ? routes.storeLive
          : next,
      );
    } catch (e) {
      handleError(e);
      if (e instanceof DataError && e.code === "REAUTH_REQUIRED") {
        const contact = ctx?.user.email ?? ctx?.user.phone;
        if (contact) sessionStorage.setItem("auth_contact", contact);
        router.replace(`${routes.forgotPassword}?reauth=1`);
      }
      if (e instanceof DataError && e.code === "UNAUTHENTICATED")
        router.replace(routes.login);
    } finally {
      setBusy(false);
    }
  }
  const captcha = (
    <Captcha
      action={
        verify
          ? "resend"
          : forgot
            ? "recover"
            : mode === "register"
              ? "signup"
              : "login"
      }
      resetKey={reset}
      onToken={setToken}
      onExpire={() => setToken("")}
      onReset={() => setToken("")}
    />
  );
  const errorBlock = (
    <>
      {(error || query.has("reauth")) && (
        <p role="alert" className="field-error">
          {error || "为了安全，请重新验证"}
        </p>
      )}
      {errorCode === "NETWORK" && (
        <button
          disabled={
            busy ||
            ((["login", "register", "forgot-password"].includes(mode) ||
              (verify && !phone)) &&
              !token)
          }
          onClick={() => {
            if (passwordMode) void save();
            else if (mode === "confirm") void confirm();
            else if (verify && phone) void verifyCode(otp);
            else if (mode === "login") void login();
            else void send();
          }}
        >
          重试
        </button>
      )}
      {["FORBIDDEN", "UNSUPPORTED_MEDIA_TYPE"].includes(errorCode) && (
        <button
          onClick={() => {
            router.refresh();
            setError("");
            setErrorCode("");
          }}
        >
          刷新
        </button>
      )}
    </>
  );
  const accountField = (
    <>
      <div className="auth-tabs">
        <button
          type="button"
          aria-pressed={kind === "email"}
          onClick={() => {
            setKind("email");
            setAccount("");
          }}
        >
          邮箱
        </button>
        <button
          type="button"
          aria-pressed={kind === "phone"}
          onClick={() => {
            setKind("phone");
            setAccount("");
          }}
        >
          手机号
        </button>
      </div>
      <label>
        {kind === "phone" ? "手机号（+60）" : "邮箱"}
        <input
          required
          maxLength={kind === "email" ? 254 : 32}
          type={kind === "email" ? "email" : "tel"}
          inputMode={kind === "email" ? "email" : "numeric"}
          autoComplete={kind === "email" ? "email" : "tel"}
          value={account}
          onChange={(e) => setAccount(e.target.value)}
        />
      </label>
      <span className="field-error">{fieldErrors.account}</span>
    </>
  );
  return (
    <main className="auth-wrap">
      <section className="card auth-card">
        <p className="muted">{platformName}</p>
        <h1>{title}</h1>
        {errorBlock}
        {success && <p role="status">{success}</p>}
        {mode === "confirm" ? (
          <>
            <p>点下面的按钮继续</p>
            {errorCode === "RESET_LINK_INVALID" ? (
              <Link
                href={
                  next === routes.resetPassword
                    ? routes.forgotPassword
                    : routes.register
                }
              >
                重新发送
              </Link>
            ) : (
              <button
                className="button primary"
                disabled={busy}
                onClick={() => void confirm()}
              >
                {busy ? "请稍候…" : "确认"}
              </button>
            )}
          </>
        ) : passwordMode ? (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <p>
              {mode === "set-password"
                ? "验证已完成，设好密码后就能用密码登录"
                : "请填写新密码"}
            </p>
            <label>
              新密码
              <input
                type={show ? "text" : "password"}
                autoComplete="new-password"
                maxLength={72}
                value={password}
                onChange={(e) => setPass(e.target.value)}
              />
              <span className="field-error">{fieldErrors.password}</span>
            </label>
            <label>
              确认新密码
              <input
                type={show ? "text" : "password"}
                autoComplete="new-password"
                maxLength={72}
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
              />
              <span className="field-error">{fieldErrors.confirmation}</span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={show}
                onChange={(e) => setShow(e.target.checked)}
              />
              显示密码
            </label>
            <p>密码至少 8 位，需包含字母和数字</p>
            <small>请在验证后 5 分钟内完成</small>
            <button className="button primary" disabled={busy}>
              {busy ? "请稍候…" : "保存密码"}
            </button>
          </form>
        ) : verify && ctx && !ctx.store ? (
          <>
            <p>账号还没有完成设置</p>
            <button
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void ensureMyStore()
                  .then((r) => {
                    if (!r.store_id) throw Error();
                    return done();
                  })
                  .catch(() => setError("暂时无法完成设置，请联系平台"))
                  .finally(() => setBusy(false));
              }}
            >
              完成设置
            </button>
            <button
              onClick={() =>
                void signOut().then(() => router.replace(routes.login))
              }
            >
              退出登录
            </button>
          </>
        ) : verify ? (
          <>
            {phone ? (
              <>
                <p>
                  验证码已发到 {phone.slice(0, 5)}-*** {phone.slice(-4)}（10
                  分钟内有效）。没收到可以 60 秒后重新发送。
                </p>
                <form
                  noValidate
                  onSubmit={(e) => {
                    e.preventDefault();
                    void verifyCode(otp);
                  }}
                >
                  <label>
                    6 位验证码
                    <input
                      autoComplete="one-time-code"
                      inputMode="numeric"
                      pattern="[0-9]{6}"
                      maxLength={6}
                      value={otp}
                      onChange={(e) => {
                        const v = e.target.value.replace(/\D/g, "").slice(0, 6);
                        setOtp(v);
                        if (v.length === 6) void verifyCode(v);
                      }}
                    />
                  </label>
                  <button
                    disabled={
                      busy ||
                      otp.length !== 6 ||
                      attempts >= 5 ||
                      (seconds > 0 && errorCode === "RATE_LIMITED")
                    }
                  >
                    {busy ? "正在验证…" : "验证"}
                  </button>
                </form>
                {captcha}
                <button
                  disabled={busy || seconds > 0 || !token}
                  onClick={() => void send()}
                >
                  {seconds ? `重新发送（${seconds} 秒）` : "重新发送"}
                </button>
              </>
            ) : (
              <form
                noValidate
                onSubmit={(e) => {
                  e.preventDefault();
                  setKind("phone");
                  void send();
                }}
              >
                <p>请输入手机号，我们会发一条 6 位验证码</p>
                <label>
                  手机号（+60）
                  <input
                    type="tel"
                    inputMode="numeric"
                    autoComplete="tel"
                    value={account}
                    onChange={(e) => {
                      setKind("phone");
                      setAccount(e.target.value);
                    }}
                  />
                </label>
                {captcha}
                <button disabled={busy || !token || seconds > 0}>
                  发送验证码
                </button>
              </form>
            )}
            <Link
              href={
                next === routes.resetPassword
                  ? routes.forgotPassword
                  : routes.register
              }
            >
              换个号码 / 改用邮箱
            </Link>
            <small>{cleanupHint}</small>
          </>
        ) : (
          <>
            <form
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                void (mode === "login" && !sent ? login() : send());
              }}
            >
              {!sent ? (
                accountField
              ) : (
                <>
                  <p>
                    {forgot
                      ? "邮件已发出，请查收（15 分钟内有效）。没收到可以 60 秒后重新发送。"
                      : "如果这个邮箱可以使用，验证邮件已发出，请查收（也看看垃圾邮件），点邮件里的链接完成验证"}
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setSent(false);
                      setAccount("");
                    }}
                  >
                    换个邮箱
                  </button>
                </>
              )}
              {mode === "login" && !sent && (
                <>
                  <label>
                    密码
                    <input
                      type={show ? "text" : "password"}
                      autoComplete="current-password"
                      maxLength={72}
                      value={password}
                      onChange={(e) => setPass(e.target.value)}
                    />
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={show}
                      onChange={(e) => setShow(e.target.checked)}
                    />
                    显示密码
                  </label>
                </>
              )}
              {captcha}
              <button
                className="button primary"
                disabled={!token || busy || seconds > 0}
              >
                {busy
                  ? "请稍候…"
                  : seconds
                    ? `重新发送（${seconds} 秒）`
                    : sent
                      ? "重新发送"
                      : mode === "login"
                        ? "登录"
                        : forgot
                          ? "发送"
                          : "发送验证"}
              </button>
            </form>
            {["EMAIL_NOT_CONFIRMED", "PHONE_NOT_CONFIRMED"].includes(
              errorCode,
            ) && (
              <button disabled={!token || busy} onClick={() => void send()}>
                重新发送
              </button>
            )}
            {mode === "login" ? (
              <>
                <Link
                  className={
                    errorCode === "INVALID_CREDENTIALS" ? "field-error" : ""
                  }
                  onClick={() =>
                    sessionStorage.setItem("auth_contact", account)
                  }
                  href={routes.forgotPassword}
                >
                  还没设密码？用验证码登录
                </Link>
                <Link
                  onClick={() =>
                    sessionStorage.setItem("auth_contact", account)
                  }
                  href={routes.forgotPassword}
                >
                  忘记密码？
                </Link>
                <Link href={routes.register}>还没有账号？免费注册</Link>
              </>
            ) : (
              <Link href={routes.login}>
                {forgot ? "返回登录" : "已有账号？登录"}
              </Link>
            )}
            {forgot && <p className="muted">{resetDescriptions[kind]}</p>}
            {mode !== "login" && <small>{cleanupHint}</small>}
          </>
        )}
      </section>
    </main>
  );
}
