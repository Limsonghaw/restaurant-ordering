import { DataError } from "../data/types";
import { goneMessages } from "../format";
/** All 410 responses stop polling; only the documented code/reason selects specific copy. */
export function billGoneState(error: unknown) {
  if (!(error instanceof DataError) || error.status !== 410) return undefined;
  const reason =
    error.code === "BILL_TOKEN_EXPIRED" ? error.details.reason : undefined;
  if (reason === "qr_rotated" || reason === "bill_paid" || reason === "expired")
    return {
      reason,
      message: goneMessages[reason],
      stopPolling: true as const,
    };
  return {
    reason: "unknown",
    message: "页面已失效，请重新扫码",
    stopPolling: true as const,
  };
}
