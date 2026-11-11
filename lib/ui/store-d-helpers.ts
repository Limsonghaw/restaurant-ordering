import { DataError, type LiveOrder } from "../data/types";
import { formatMoney } from "../format";
// 最终以后端校验为准。Parse decimal digits, never multiply a float by 100.
export function percentToBp(text: string, max: number): number | undefined {
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return undefined;
  const [whole, fraction = ""] = text.split(".");
  const bp = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(bp) && bp <= max * 100 ? bp : undefined;
}
export function bpToPercent(bp: number) {
  return `${Math.floor(bp / 100)}${
    bp % 100
      ? `.${String(bp % 100)
          .padStart(2, "0")
          .replace(/0$/, "")}`
      : ""
  }`;
}
export const needsClosingConfirmation = (next: boolean) => !next;
export const pauseMessage = "关闭后顾客不能下单，确定暂停接单？";
export const disableTableMessage =
  "停用后扫这张桌子的二维码会显示「二维码已失效」，确定停用？";
export const resetTableMessage = (label: string) =>
  `重置后，${label} 桌的旧二维码立即失效，正在用餐的顾客需要重新扫码。重置后请重新下载并打印这张桌子的二维码。确定重置？`;
export const resetTableNotice = (label: string) =>
  `已重置，请重新下载并打印 ${label} 桌的二维码`;
export const unservedCount = (orders: Pick<LiveOrder, "status">[]) =>
  orders.filter((o) => o.status === "new" || o.status === "accepted").length;
export const unservedMessage = (n: number) =>
  n > 0 ? `这桌还有 ${n} 单未上菜，确定要结账吗？` : "";
export function paymentFailure(error: unknown) {
  if (error instanceof DataError && String(error.code) === "BILL_ALREADY_PAID")
    return { close: true, message: "这桌已经结账" };
  if (
    error instanceof DataError &&
    String(error.code) === "BILL_TOTAL_CHANGED"
  ) {
    const total = error.details.total_cents;
    if (typeof total === "number" && Number.isSafeInteger(total) && total >= 0)
      return {
        close: false,
        total,
        message: `这桌金额已变化，新的总计是 ${formatMoney(total)}，请再确认`,
      };
  }
  return { close: false, message: "标记没有成功，请重试" };
}
export const malaysiaToday = (now = Date.now()) =>
  new Date(now + 8 * 3600000).toISOString().slice(0, 10);
export const adjacentDay = (date: string, offset: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + offset * 86400000)
    .toISOString()
    .slice(0, 10);
export function validHistoryDate(date: string, today: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(`${date}T00:00:00Z`)) &&
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date &&
    date <= today
  );
}
export function tableQrUrl(path: string, siteUrl: string | undefined) {
  // Mock development uses a fixed placeholder when no public site is configured.
  // Never derive the QR origin from browser location or request headers.
  const origin = new URL(siteUrl || "http://localhost:3000").origin;
  const target = new URL(path, origin);
  return new URL(`${target.pathname}${target.search}${target.hash}`, origin)
    .href;
}
export function printGroups<T>(cards: T[]) {
  return Array.from({ length: Math.ceil(cards.length / 4) }, (_, i) => ({
    cards: cards.slice(i * 4, i * 4 + 4),
    breakAfter: (i + 1) * 4 < cards.length,
  }));
}
