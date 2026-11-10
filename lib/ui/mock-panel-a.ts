// PR-B / PR-C 可各自增加注册文件，由 mock-panel.tsx 出口追加。
export const orderScenariosA = [
  "",
  "PRICE_CHANGED",
  "ITEM_UNAVAILABLE",
  "STORE_CLOSED",
  "ORDER_LIMIT_EXCEEDED",
  "DEVICE_BLOCKED",
  "CAPTCHA_REQUIRED",
  "CAPTCHA_REQUIRED_IP",
  "RATE_LIMITED_30",
  "RATE_LIMITED_120",
  "NETWORK_AFTER",
];
export const scenarioLabelsA: Record<string, string> = {
  "": "正常",
  CAPTCHA_REQUIRED_IP: "CAPTCHA_REQUIRED（ip_db）",
  RATE_LIMITED_30: "RATE_LIMITED（30 秒）",
  RATE_LIMITED_120: "RATE_LIMITED（同一网络 120 秒）",
  NETWORK_AFTER: "下单已保存但响应丢失（验证幂等重试）",
};
