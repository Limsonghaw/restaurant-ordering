import { DataError, type ErrorCode, type MerchantErrorCode } from "../types";

const messages = {
  UNAUTHENTICATED: "请先登录", FORBIDDEN: "没有权限", NOT_FOUND: "记录不存在",
  STORE_SUSPENDED: "店铺已被平台停用，请联系平台", VALIDATION_FAILED: "填写的内容不正确",
  CATEGORY_NOT_EMPTY: "请先移走或删除这个分类下的菜品", TABLE_LABEL_TAKEN: "桌名已被使用",
  TABLE_HAS_OPEN_BILL: "这张桌子还有未结账单", CONFLICT: "记录已存在",
  INTERNAL: "操作失败，请稍后重试", ORDER_BILL_CLOSED: "这张订单已被处理",
  FILE_TOO_LARGE: "图片不能超过 2 MB", UNSUPPORTED_FILE_TYPE: "只支持 JPG、PNG 或 WebP 图片",
  UPLOAD_FAILED: "上传失败，请重试",
} satisfies Record<MerchantErrorCode, string>;

export function dataError(code: MerchantErrorCode): DataError {
  const status = code === "INTERNAL" ? 500 : code === "UNAUTHENTICATED" ? 401
    : ["FORBIDDEN", "STORE_SUSPENDED"].includes(code) ? 403 : code === "NOT_FOUND" ? 404
    : code === "FILE_TOO_LARGE" ? 413 : code === "UNSUPPORTED_FILE_TYPE" ? 415
    : ["CONFLICT", "TABLE_LABEL_TAKEN", "CATEGORY_NOT_EMPTY", "TABLE_HAS_OPEN_BILL", "ORDER_BILL_CLOSED"].includes(code) ? 409 : 400;
  // Frontend ErrorCode is frozen by PR2's append-only contract. Runtime codes include
  // the four database codes declared in MerchantErrorCode at the end of types.ts.
  return new DataError(code as ErrorCode, messages[code], {}, status);
}

export function mapPgError(error: { code?: string; message?: string; details?: string; constraint?: string }): DataError {
  if (error.code === "P0001" && error.message && Object.hasOwn(messages, error.message))
    return dataError(error.message as MerchantErrorCode);
  if (error.code === "42501") return dataError("FORBIDDEN");
  if (error.code === "23514") return dataError("VALIDATION_FAILED");
  if (error.code === "23505") {
    // PostgREST embeds the constraint name in message; never expose its text.
    const constraint = error.constraint ?? error.message?.match(/constraint "([^"]+)"/)?.[1];
    return dataError(constraint === "dining_tables_store_label_uq" ? "TABLE_LABEL_TAKEN" : "CONFLICT");
  }
  return dataError("INTERNAL");
}

export async function result<T>(request: PromiseLike<{ data: T | null; error: { code?: string; message?: string } | null }>): Promise<T> {
  try {
    const { data, error } = await request;
    if (error) throw mapPgError(error);
    return data as T;
  } catch (error) {
    if (error instanceof DataError) throw error;
    throw dataError("INTERNAL");
  }
}
