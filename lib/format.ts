import { DataError, type CancelReason, type OrderStatus } from "./data/types";
export const formatMoney = (cents: number) => `RM ${(cents / 100).toFixed(2)}`;
export const formatTime = (value: string) =>
  new Intl.DateTimeFormat("zh-Hans", {
    timeZone: "Asia/Kuala_Lumpur",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
export const orderLabels: Record<OrderStatus, string> = {
  new: "新订单",
  accepted: "已接单",
  served: "已上菜",
  cancelled: "已取消",
};
export const cancelLabels: Record<CancelReason, string> = {
  sold_out: "菜品售完",
  customer_request: "客人要求取消",
  duplicate: "重复下单",
  other: "其他",
};
export const storeLabels = { active: "正常", suspended: "已停用" };
export function errorMessage(error: unknown) {
  if (!(error instanceof DataError)) return "网络出错，请检查网络后重试";
  return (
    (
      {
        TABLE_INVALID: "这个二维码已失效，请联系店员",
        STORE_SUSPENDED: "本店暂停服务",
        NETWORK: "网络出错，请检查网络后重试",
        DEVICE_BLOCKED: "暂时无法在这台手机下单，请联系店员",
        STORE_CLOSED: "暂停接单",
        ORDER_LIMIT_EXCEEDED: "单张订单最多 RM 3,000（或 200 件），请分开下单",
        PRICE_CHANGED: "价格已更新，请确认后再下单",
        ITEM_UNAVAILABLE: "有菜品刚售完，请移除后再下单",
        CAPTCHA_FAILED: "人机验证没有通过，请再试一次",
        CAPTCHA_REQUIRED: "请先完成人机验证",
        IDEMPOTENCY_KEY_REUSED: "请重新确认下单",
      } as Partial<Record<string, string>>
    )[error.code] ?? error.message
  );
}
export const goneMessages = {
  bill_paid: "已结账，谢谢光临",
  qr_rotated: "二维码已更新，请重新扫码",
  expired: "页面已过期，请重新扫码",
};
export const countdownRemaining = (deadline: number, now = Date.now()) =>
  Math.max(0, Math.ceil((deadline - now) / 1000));
