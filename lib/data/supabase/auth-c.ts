import { DataError, type AuthContact } from "../types";
import type * as Mock from "../mock/auth-c";
import { createClient } from "../../supabase/client";
import { isExistingAccount, toAuthError } from "../../auth/gotrue-errors";
import { normalizePhone } from "../../validation/phone";
import { safeNext } from "../../auth/safe-next";
function contact(input: AuthContact): AuthContact {
  if (input.phone !== undefined) return { phone: normalizePhone(input.phone) };
  const email = input.email.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new DataError("VALIDATION_FAILED", "请输入正确的邮箱");
  return { email };
}
async function send(input: AuthContact, options: { captcha_token: string }, recovery: boolean) {
  const site = process.env.NEXT_PUBLIC_SITE_URL;
  if (!site) throw toAuthError(null);
  try {
    const { error } = await createClient().auth.signInWithOtp({ ...contact(input), options: {
      shouldCreateUser: true, captchaToken: options.captcha_token,
      emailRedirectTo: site + (recovery ? "/reset-password" : "/store"),
    } });
    if (error && !isExistingAccount(error)) throw toAuthError(error);
  } catch (error) { if (error instanceof DataError) throw error; if (!isExistingAccount(error)) throw toAuthError(error); }
}
export const sendSignUpOtp: typeof Mock.sendSignUpOtp = (input, options) => send(input, options, false);
export const requestPasswordReset: typeof Mock.requestPasswordReset = (input, options) => send(input, options, true);
async function checked(operation: () => PromiseLike<{ error: unknown }>) {
  try { const { error } = await operation(); if (error) throw toAuthError(error); }
  catch (error) { throw error instanceof DataError ? error : toAuthError(error); }
}
export const confirmEmailLink: typeof Mock.confirmEmailLink = async (input) => {
  if (input.type !== "email" && input.type !== "recovery" && input.type !== "email_change") throw toAuthError(null, "RESET_LINK_INVALID");
  try { await checked(() => createClient().auth.verifyOtp({ token_hash: input.token_hash, type: input.type as "email" | "recovery" | "email_change" })); }
  catch { throw toAuthError(null, "RESET_LINK_INVALID"); }
  return { next: safeNext(input.next) };
};
export const verifySmsOtp: typeof Mock.verifySmsOtp = async ({ phone, token }) => {
  try { await checked(() => createClient().auth.verifyOtp({ phone: normalizePhone(phone), token, type: "sms" })); }
  catch { throw toAuthError(null, "OTP_INVALID"); }
};
export const signInWithPassword: typeof Mock.signInWithPassword = async (input) => {
  await checked(() => createClient().auth.signInWithPassword({ ...contact(input), password: input.password, options: { captchaToken: input.captcha_token } }));
};
export const setPassword: typeof Mock.setPassword = async (password) => {
  let response: Response;
  try { response = await fetch("/api/auth/set-password", { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", body: JSON.stringify({ password }) }); }
  catch { throw toAuthError(null); }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    // Only recognize application codes; never display response messages.
    const { ERRORS } = await import("../../api/errors");
    const code = body?.error?.code;
    throw toAuthError(null, typeof code === "string" && Object.hasOwn(ERRORS, code) ? code as keyof typeof ERRORS : "INTERNAL");
  }
  return { ok: true, next: "/store" };
};
export const signOut: typeof Mock.signOut = () => checked(() => createClient().auth.signOut());
export const ensureMyStore: typeof Mock.ensureMyStore = async () => {
  try { const { data, error } = await createClient().rpc("ensure_my_store"); if (error) throw toAuthError(error); return data as Awaited<ReturnType<typeof Mock.ensureMyStore>>; }
  catch (error) { throw error instanceof DataError ? error : toAuthError(error); }
};
const unavailable = async () => { throw new DataError("NOT_IMPLEMENTED", "未实现"); };
export const getAuthMockSnapshot: typeof Mock.getAuthMockSnapshot = unavailable;
export const authMockAction: typeof Mock.authMockAction = unavailable;
