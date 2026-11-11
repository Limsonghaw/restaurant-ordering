import { DataError } from "../data/types";
const generic = "操作没有成功，请稍后再试";
function fields(error: unknown, messages: Record<string, string>) {
  if (!(error instanceof DataError) || error.code !== "VALIDATION_FAILED")
    return {};
  const field = error.details.field;
  return typeof field === "string" && Object.hasOwn(messages, field)
    ? { [field]: messages[field] }
    : {};
}
export function authFieldErrors(error: unknown): Record<string, string> {
  const hints = fields(error, {
    account: "请输入正确的邮箱或手机号",
    email: "请输入正确的邮箱",
    phone: "请输入正确的手机号",
  });
  const hint = Object.values(hints)[0];
  return hint ? { account: hint } : {};
}
export const menuFieldErrors = (error: unknown) =>
  fields(error, {
    name: "请填写菜名（最多 40 字）",
    category_id: "请选择有效分类",
    price: "价格格式不正确",
    description: "介绍最多 300 字",
    image: "图片格式不正确",
  });
export function uploadError(error: unknown) {
  const messages: Record<string, string> = {
    FILE_TOO_LARGE: "图片不能超过 2 MB",
    UNSUPPORTED_FILE_TYPE: "只支持 JPG、PNG 或 WebP 图片",
    UPLOAD_FAILED: "上传失败，请重试",
  };
  return error instanceof DataError && Object.hasOwn(messages, error.code)
    ? messages[error.code]
    : generic;
}
