import {
  parsePhoneNumberFromString,
  type CountryCode,
} from "libphonenumber-js/max";
import { DataError } from "../data/types";
// 最终以后端校验为准。
export function normalizePhone(value: string): string {
  const phone = parsePhoneNumberFromString(value, "MY");
  if (
    !phone?.isValid() ||
    !["MOBILE", "FIXED_LINE_OR_MOBILE"].includes(phone.getType() ?? "")
  )
    throw new DataError("VALIDATION_FAILED", "请输入正确的手机号");
  const countries = (process.env.NEXT_PUBLIC_AUTH_SMS_ALLOWED_COUNTRIES || "MY")
    .split(",")
    .map((c) => c.trim() as CountryCode);
  if (!phone.country || !countries.includes(phone.country))
    throw new DataError(
      "PHONE_NOT_SUPPORTED",
      "暂不支持这个国家或地区的手机号，请改用邮箱",
    );
  return phone.number;
}
export const validPassword = (p: string) =>
  p.length >= 8 && p.length <= 72 && /[a-zA-Z]/.test(p) && /[0-9]/.test(p);
