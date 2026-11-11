import { DataError, type ErrorCode } from "../data/types";
import { AppError, ERRORS, type AppCode } from "../api/errors";
export const GOTRUE_TO_APP: Record<string, AppCode> = {
  invalid_credentials: "INVALID_CREDENTIALS",
  user_not_found: "INVALID_CREDENTIALS",
  email_not_confirmed: "EMAIL_NOT_CONFIRMED",
  phone_not_confirmed: "PHONE_NOT_CONFIRMED",
  captcha_failed: "CAPTCHA_FAILED",
  otp_expired: "OTP_INVALID",
  otp_disabled: "OTP_INVALID",
  weak_password: "WEAK_PASSWORD",
  same_password: "VALIDATION_FAILED",
  over_request_rate_limit: "RATE_LIMITED",
  over_sms_send_rate_limit: "RATE_LIMITED",
  over_email_send_rate_limit: "RATE_LIMITED",
  sms_send_failed: "SMS_SEND_FAILED",
  validation_failed: "VALIDATION_FAILED",
  reauthentication_needed: "REAUTH_REQUIRED",
  session_not_found: "UNAUTHENTICATED",
  session_expired: "UNAUTHENTICATED",
  user_already_exists: "VALIDATION_FAILED",
  email_exists: "VALIDATION_FAILED",
  phone_exists: "VALIDATION_FAILED",
};
export function isExistingAccount(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    ["user_already_exists", "email_exists", "phone_exists"].includes(
      String(error.code),
    )
  );
}
export function toAppCode(error: unknown): AppCode {
  if (!error || typeof error !== "object") return "INTERNAL";
  const e = error as {
    code?: string;
    message?: string;
    status?: number;
    name?: string;
  };
  if (e.code === "P0001" && e.message && Object.hasOwn(ERRORS, e.message))
    return e.message as AppCode;
  if (e.code === "42501") return "FORBIDDEN";
  if (e.code === "23514") return "VALIDATION_FAILED";
  if (e.status === 429) return "RATE_LIMITED";
  if (e.message?.includes("PHONE_NOT_SUPPORTED")) return "PHONE_NOT_SUPPORTED";
  if (
    e.code === "sms_send_failed" &&
    /60203|max send attempts|too many requests|429/i.test(e.message ?? "")
  )
    return "RATE_LIMITED";
  if (e.name === "AuthSessionMissingError") return "UNAUTHENTICATED";
  return e.code && Object.hasOwn(GOTRUE_TO_APP, e.code)
    ? GOTRUE_TO_APP[e.code]
    : "INTERNAL";
}
/** DataError's shared union predates INTERNAL; preserve its runtime shape locally. */
export function toAuthError(error: unknown, override?: AppCode): DataError {
  const code = override ?? toAppCode(error);
  return new DataError(
    code as ErrorCode,
    ERRORS[code].message,
    {},
    ERRORS[code].status,
    code === "RATE_LIMITED" ? 60 : 0,
  );
}
export function toGoTrueError(error: unknown): AppError {
  return new AppError(toAppCode(error));
}
