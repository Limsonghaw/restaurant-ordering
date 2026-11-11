import {
  DataError,
  type AuthContact,
  type AuthMail,
  type AuthMockSnapshot,
  type ErrorCode,
  type Session,
} from "../types";
import { safeNext } from "../../auth/safe-next";
import { normalizePhone, validPassword } from "../../auth/validation";
import { delay, readState, saveState } from "./state";
interface Account {
  id: string;
  email: string | null;
  phone: string | null;
  password_hash: string | null;
  password_set_at: string | null;
  verified: boolean;
  created_at: number;
  store_id: string | null;
  admin: boolean;
}
interface AuthData {
  accounts: Account[];
  identity: string | null;
  aal: "aal1" | "aal2";
  mails: AuthMail[];
  verified_at: number;
  sent: Record<string, number>;
  failures: Record<string, ErrorCode>;
  sms: Record<string, { expires: number; attempts: number }>;
  used_captcha_hashes: string[];
  session_version: number;
}
const key = "ro-mock:auth-c-v1";
// Each loaded mock session retains its revision; password changes revoke other loaded sessions.
let sessionVersion: number | undefined;
// Only a SHA-256 digest of the explicitly fake demo password is persisted.
const demoHash =
  "190ab38c2d97b9279e50fcbc9518e43b9a15884234301266d40d6b2d86d4dc9d";
export function authRead(): AuthData {
  const raw = localStorage.getItem(key);
  if (raw) {
    const data = JSON.parse(raw) as AuthData;
    data.accounts = data.accounts.filter(
      (u) => u.verified || Date.now() - u.created_at < 86400000,
    );
    return data;
  }
  const accounts = [
    "owner",
    "new",
    "nopw",
    "disabled",
    "admin",
    "nostore",
    "unverified",
  ].map((name, i): Account => ({
    id: `auth-${name}`,
    email: `${name}@demo.test`,
    phone: i === 0 ? "+60120000001" : null,
    password_hash: [2, 6].includes(i) ? null : demoHash,
    password_set_at: [2, 6].includes(i) ? null : new Date().toISOString(),
    verified: i !== 6,
    created_at: Date.now(),
    store_id: [4, 5, 6].includes(i)
      ? null
      : i === 3
        ? "store-3"
        : i === 0
          ? "store-0"
          : `auth-store-${name}`,
    admin: i === 4,
  }));
  const result: AuthData = {
    accounts,
    identity: null,
    aal: "aal2",
    mails: [],
    verified_at: 0,
    sent: {},
    failures: {},
    sms: {},
    used_captcha_hashes: [],
    session_version: 0,
  };
  authSave(result);
  return result;
}
export function authSave(data: AuthData) {
  localStorage.setItem(key, JSON.stringify(data));
  window.dispatchEvent(new Event("ro-mock:change"));
}
async function digest(value: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  )
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
export async function sessionC(): Promise<Session | null> {
  const a = authRead();
  sessionVersion ??= a.session_version;
  if (sessionVersion !== a.session_version) return null;
  const account = a.accounts.find((u) => u.id === a.identity);
  if (!account) return null;
  const state = readState();
  let store = state.stores.find((s) => s.id === account.store_id) ?? null;
  if (!store && account.store_id) {
    store = {
      ...state.stores[0],
      id: account.store_id,
      slug: account.store_id,
      name: "我的餐厅",
      address: "",
      opening_hours: "",
      is_profile_complete: false,
      status: "active",
      status_changed_at: null,
      is_accepting_orders: true,
    };
    state.stores.push(store);
    saveState(state);
  }
  return {
    user_id: account.id,
    user: { id: account.id, email: account.email, phone: account.phone },
    platform_role: account.admin ? "platform_admin" : "merchant",
    aal: a.aal,
    password_set: !!account.password_hash,
    password_set_at: account.password_set_at,
    member_role: account.admin ? null : "owner",
    store: store
      ? {
          id: store.id,
          slug: store.slug,
          name: store.name,
          logo_path: store.logo_path,
          status: store.status,
          status_changed_at: store.status_changed_at,
          is_accepting_orders: store.is_accepting_orders,
          is_profile_complete: store.is_profile_complete,
        }
      : null,
  };
}
function fail(a: AuthData, operation: string) {
  const code = a.failures[operation];
  if (code) {
    delete a.failures[operation];
    authSave(a);
    throw new DataError(
      code,
      code,
      {},
      code === "FORBIDDEN" ? 403 : 400,
      code === "RATE_LIMITED" ? 60 : 0,
    );
  }
}
async function captcha(token: string) {
  const hash = await digest(token);
  const a = authRead();
  const state = readState();
  if (state.settings.captcha_fail) {
    state.settings.captcha_fail = false;
    saveState(state);
    throw new DataError("CAPTCHA_FAILED", "人机验证失败，请重试");
  }
  if (!token || a.used_captcha_hashes.includes(hash))
    throw new DataError("CAPTCHA_FAILED", "人机验证失败，请重试");
  a.used_captcha_hashes.push(hash);
  // Persist only digests, never captcha tokens, passwords or SMS codes.
  localStorage.setItem(key, JSON.stringify(a));
}
function contactValue(contact: AuthContact) {
  if (contact.phone !== undefined) return normalizePhone(contact.phone);
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email) ||
    contact.email.length > 254
  )
    throw new DataError("VALIDATION_FAILED", "请输入正确的邮箱");
  return contact.email.trim().toLowerCase();
}
async function send(
  contact: AuthContact,
  options: { captcha_token: string },
  recovery: boolean,
) {
  await delay();
  await captcha(options.captcha_token);
  const value = contactValue(contact);
  const a = authRead();
  fail(a, "send");
  if (Date.now() - (a.sent[value] || 0) < 60000)
    throw new DataError(
      "RATE_LIMITED",
      "请稍后再试",
      {},
      429,
      Math.ceil((60000 - Date.now() + a.sent[value]) / 1000),
    );
  a.sent[value] = Date.now();
  let account = a.accounts.find((u) => u.email === value || u.phone === value);
  if (!account) {
    account = {
      id: crypto.randomUUID(),
      email: contact.email !== undefined ? value : null,
      phone: contact.phone !== undefined ? value : null,
      password_hash: null,
      password_set_at: null,
      verified: false,
      created_at: Date.now(),
      store_id: null,
      admin: false,
    };
    a.accounts.push(account);
  }
  if (contact.email !== undefined)
    a.mails.push({
      id: `mock-${crypto.randomUUID()}`,
      recipient: value,
      type: recovery ? "重设密码" : account.verified ? "登录验证" : "注册验证",
      created_at: new Date().toISOString(),
      expires_at: Date.now() + 900000,
      used: false,
      next: recovery ? "/reset-password" : "/store",
    });
  else a.sms[value] = { expires: Date.now() + 600000, attempts: 0 };
  authSave(a);
}
// A1 signInWithOtp({ shouldCreateUser: true, emailRedirectTo: origin + '/store' })
export const sendSignUpOtp = (
  contact: AuthContact,
  options: { captcha_token: string },
) => send(contact, options, false);
// A4 / A8 signInWithOtp; emailRedirectTo: origin + '/reset-password'
export const requestPasswordReset = (
  contact: AuthContact,
  options: { captcha_token: string },
) => send(contact, options, true);
function establish(a: AuthData, account: Account) {
  account.verified = true;
  if (!account.store_id && !account.admin)
    account.store_id = `auth-store-${account.id}`;
  a.identity = account.id;
  sessionVersion = a.session_version;
  a.verified_at = Date.now();
  authSave(a);
}
// A5 verifyOtp({ token_hash, type }); no automatic verification on page load.
export async function confirmEmailLink(input: {
  token_hash: string;
  type: string;
  next: string | null;
}) {
  await delay();
  const a = authRead();
  const mail = a.mails.find((m) => m.id === input.token_hash);
  if (
    !["email", "recovery", "email_change"].includes(input.type) ||
    !mail ||
    mail.used ||
    mail.expires_at < Date.now()
  )
    throw new DataError("RESET_LINK_INVALID", "链接已失效");
  mail.used = true;
  const account = a.accounts.find((u) => u.email === mail.recipient);
  if (!account) throw new DataError("RESET_LINK_INVALID", "链接已失效");
  establish(a, account);
  return { next: safeNext(input.next) };
}
// A7 verifyOtp({ phone, token, type: 'sms' }); OTP is never persisted.
export async function verifySmsOtp({
  phone,
  token,
}: {
  phone: string;
  token: string;
}) {
  await delay();
  const a = authRead();
  fail(a, "verify");
  const entry = a.sms[phone];
  const account = a.accounts.find((u) => u.phone === phone);
  if (
    !entry ||
    !account ||
    entry.expires < Date.now() ||
    entry.attempts >= 5 ||
    token !== "123456"
  ) {
    if (entry) {
      entry.attempts++;
      authSave(a);
    }
    throw new DataError("OTP_INVALID", "验证码错误或已过期");
  }
  delete a.sms[phone];
  establish(a, account);
}
// A2 signInWithPassword
export async function signInWithPassword(
  input: AuthContact & { password: string; captcha_token: string },
) {
  await delay();
  await captcha(input.captcha_token);
  const a = authRead();
  fail(a, "login");
  const value = contactValue(input);
  const account = a.accounts.find(
    (u) => u.email === value || u.phone === value,
  );
  const hash = await digest(input.password);
  if (!account?.password_hash || account.password_hash !== hash)
    throw new DataError("INVALID_CREDENTIALS", "账号或密码不正确");
  a.identity = account.id;
  sessionVersion = a.session_version;
  a.aal = "aal2";
  a.verified_at = 0;
  authSave(a);
}
// A6; only verification in the past five minutes permits setting a password.
export async function setPassword(password: string) {
  await delay();
  const a = authRead();
  fail(a, "password");
  const account = a.accounts.find((u) => u.id === a.identity);
  if (
    !account ||
    (sessionVersion !== undefined && sessionVersion !== a.session_version)
  )
    throw new DataError("UNAUTHENTICATED", "请先登录");
  if (Date.now() - a.verified_at > 300000)
    throw new DataError("REAUTH_REQUIRED", "为了安全，请重新验证");
  if (!validPassword(password))
    throw new DataError("WEAK_PASSWORD", "密码至少 8 位，需包含字母和数字");
  const hash = await digest(password);
  if (hash === account.password_hash)
    throw new DataError("VALIDATION_FAILED", "新密码不能和原来的一样");
  a.session_version++;
  sessionVersion = a.session_version;
  account.password_hash = hash;
  account.password_set_at = new Date().toISOString();
  authSave(a);
  return { ok: true, next: "/store" };
}
// A3
export async function signOut() {
  await delay();
  const a = authRead();
  a.identity = null;
  a.verified_at = 0;
  authSave(a);
}
// R14 rpc('ensure_my_store')
export async function ensureMyStore() {
  await delay();
  const a = authRead();
  const account = a.accounts.find((u) => u.id === a.identity);
  if (!account || account.admin)
    return { store_id: null, created: false, reason: "no_store_account" };
  const created = !account.store_id;
  account.store_id ||= `auth-store-${account.id}`;
  authSave(a);
  return { store_id: account.store_id, created };
}
export async function getAuthMockSnapshot(): Promise<AuthMockSnapshot> {
  const a = authRead();
  return { identity: a.identity, aal: a.aal, mails: a.mails };
}
export async function authMockAction(action: string, value = "") {
  const a = authRead();
  if (action === "identity") {
    sessionVersion = a.session_version;
    a.identity =
      value === "anonymous"
        ? null
        : `auth-${value === "admin-aal1" ? "admin" : value}`;
    a.aal = value === "admin-aal1" ? "aal1" : "aal2";
    a.verified_at = Date.now();
  }
  if (action.startsWith("fail:"))
    a.failures[action.slice(5)] = value as ErrorCode;
  if (action === "expire-mail") {
    const m = a.mails.find((m) => m.id === value);
    if (m) m.expires_at = 0;
  }
  if (action === "use-mail") {
    const m = a.mails.find((m) => m.id === value);
    if (m) m.used = true;
  }
  if (action === "expire-sms")
    Object.values(a.sms).forEach((s) => {
      s.expires = 0;
    });
  if (action === "expire-verification") a.verified_at = 0;
  if (action === "cleanup") a.accounts = a.accounts.filter((u) => u.verified);
  if (action === "profile") {
    const s = await sessionC();
    const state = readState();
    const store = state.stores.find((u) => u.id === s?.store?.id);
    if (store) {
      store.address = "示范街 18 号";
      store.opening_hours = "每日 08:00–22:00";
      store.is_profile_complete = true;
      saveState(state);
    }
  }
  authSave(a);
}
