export const ERRORS = {
  VALIDATION_FAILED: { status: 400, message: "输入内容不符合要求" },
  UNAUTHENTICATED: { status: 401, message: "未登录" },
  FORBIDDEN: { status: 403, message: "请求被拒绝，请刷新页面后重试" },
  MFA_REQUIRED: { status: 403, message: "平台管理员还没完成两步验证" },
  UNSUPPORTED_MEDIA_TYPE: {
    status: 415,
    message: "请求格式不受支持，请刷新页面后重试",
  },
  NOT_FOUND: { status: 404, message: "不存在或不属于本店" },
  CONFLICT: { status: 409, message: "其他唯一约束冲突" },
  RATE_LIMITED: { status: 429, message: "请稍后再试" },
  INTERNAL: { status: 500, message: "服务暂时不可用，请稍后再试" },
  TABLE_INVALID: { status: 404, message: "二维码无效、桌子停用或删除" },
  STORE_SUSPENDED: { status: 403, message: "店铺已被平台停用，请联系平台" },
  STORE_CLOSED: { status: 409, message: "店家暂停接单" },
  ITEM_UNAVAILABLE: { status: 409, message: "有菜品售完或下架" },
  PRICE_CHANGED: { status: 409, message: "有菜品价格变化" },
  ORDER_LIMIT_EXCEEDED: {
    status: 422,
    message: "超金额/数量/单账单 60 单上限",
  },
  IDEMPOTENCY_KEY_REUSED: { status: 409, message: "重复请求的内容不同" },
  CAPTCHA_REQUIRED: { status: 403, message: "需要人机验证" },
  CAPTCHA_FAILED: { status: 403, message: "人机验证失败" },
  DEVICE_BLOCKED: { status: 403, message: "设备或 IP 被店家拉黑" },
  BILL_TOKEN_INVALID: { status: 401, message: "账单令牌无效" },
  BILL_TOKEN_EXPIRED: { status: 410, message: "账单令牌过期或被撤销" },
  INVALID_STATUS_TRANSITION: { status: 409, message: "不允许的状态变化" },
  ORDER_STATUS_CONFLICT: { status: 409, message: "状态已被别的设备改了" },
  ORDER_BILL_CLOSED: { status: 409, message: "账单已付款，不能取消订单" },
  BILL_ALREADY_PAID: { status: 409, message: "账单已付款" },
  BILL_TOTAL_CHANGED: { status: 409, message: "金额已变化，请重新确认" },
  CATEGORY_NOT_EMPTY: { status: 409, message: "分类下还有菜品" },
  TABLE_LABEL_TAKEN: { status: 409, message: "桌名重复" },
  TABLE_HAS_OPEN_BILL: { status: 409, message: "桌子有未结账单" },
  INVALID_CREDENTIALS: { status: 401, message: "账号或密码不正确" },
  EMAIL_NOT_CONFIRMED: { status: 403, message: "邮箱未验证" },
  WEAK_PASSWORD: { status: 400, message: "密码太弱" },
  PHONE_NOT_CONFIRMED: { status: 403, message: "手机号未验证" },
  PHONE_NOT_SUPPORTED: {
    status: 400,
    message: "暂不支持这个国家或地区的手机号",
  },
  OTP_INVALID: { status: 400, message: "验证码错误或已过期" },
  RESET_LINK_INVALID: { status: 400, message: "邮件链接无效或过期" },
  REAUTH_REQUIRED: { status: 401, message: "为了安全，请重新验证" },
  SMS_SEND_FAILED: {
    status: 502,
    message: "短信发送失败，请改用邮箱或稍后再试",
  },
  FILE_TOO_LARGE: { status: 413, message: "图片超过 2 MB" },
  UNSUPPORTED_FILE_TYPE: { status: 415, message: "只支持 JPG / PNG / WebP" },
} as const;
export type AppCode = keyof typeof ERRORS;
export class AppError extends Error {
  constructor(public code: AppCode) {
    super(ERRORS[code].message);
  }
}
export function toErrorResponse(error: unknown): Response {
  const code = error instanceof AppError ? error.code : "INTERNAL";
  return Response.json(
    { error: { code, message: ERRORS[code].message } },
    {
      status: ERRORS[code].status,
      headers: {
        "Cache-Control": "no-store",
        ...(code === "RATE_LIMITED" ? { "Retry-After": "60" } : {}),
      },
    },
  );
}
