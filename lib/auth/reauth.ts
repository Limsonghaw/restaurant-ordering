const FRESH = new Set([
  "otp",
  "magiclink",
  "recovery",
  "email/signup",
  "sms/signup",
]);
export function hasFreshVerification(amr: unknown, now = Date.now()): boolean {
  return (
    Array.isArray(amr) &&
    amr.some((entry: unknown) => {
      if (!entry || typeof entry !== "object") return false;
      const { method, timestamp } = entry as {
        method?: unknown;
        timestamp?: unknown;
      };
      return (
        typeof method === "string" &&
        FRESH.has(method) &&
        typeof timestamp === "number" &&
        Number.isFinite(timestamp) &&
        timestamp * 1000 <= now &&
        now - timestamp * 1000 <= 300000
      );
    })
  );
}
