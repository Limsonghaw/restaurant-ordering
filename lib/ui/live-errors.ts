import { DataError, type ErrorCode } from "../data/types";

const messages: Partial<Record<ErrorCode, string>> = {
  NETWORK: "网络出错，请检查网络后重试",
  UNAUTHENTICATED: "登录已过期，请重新登录",
  STORE_SUSPENDED: "店铺已停用，无法进行操作，请联系管理员",
  FORBIDDEN: "没有店铺操作权限",
  ORDER_STATUS_CONFLICT: "这张订单已被处理",
  INVALID_STATUS_TRANSITION: "这张订单已被处理",
  ORDER_BILL_CLOSED: "这桌已结账，不能取消订单",
};

export function liveErrorMessage(error: unknown): string {
  return (
    (error instanceof DataError && Object.hasOwn(messages, error.code)
      ? messages[error.code]
      : undefined) ?? "操作没有成功，请稍后再试"
  );
}
