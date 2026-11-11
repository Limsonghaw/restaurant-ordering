/** Preview and all other hosted Vercel environments are non-local. */
export function isNonLocalEnv(): boolean {
  return process.env.NODE_ENV === "production" || !!process.env.VERCEL_ENV?.trim();
}
export function assertLocalOverrides(): void {
  if (!isNonLocalEnv()) return;
  if (process.env.TRUST_LOCAL_IP !== undefined)
    throw new Error("Invalid configuration: TRUST_LOCAL_IP is local-only");
  if (process.env.CUSTOMER_DB_SSL === "disable")
    throw new Error("Invalid configuration: CUSTOMER_DB_SSL=disable is local-only");
}
