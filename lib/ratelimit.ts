import { randomUUID } from "node:crypto";
import { AppError } from "./api/errors";
export interface RateLimiter {
  hit(key: string, windowMs: number): Promise<number>;
}
export class MemoryRateLimiter implements RateLimiter {
  private entries = new Map<string, number[]>();
  constructor(private now = Date.now) {}
  async hit(key: string, windowMs: number) {
    const now = this.now();
    const values = (this.entries.get(key) ?? []).filter(
      (t) => t > now - windowMs,
    );
    values.push(now);
    this.entries.set(key, values);
    return values.length;
  }
}
// Atomic sliding window; Redis TIME avoids clock skew between application instances.
const script = `local t=redis.call('TIME'); local n=t[1]*1000+math.floor(t[2]/1000); redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',n-ARGV[1]); redis.call('ZADD',KEYS[1],n,ARGV[2]); redis.call('PEXPIRE',KEYS[1],ARGV[1]); return redis.call('ZCARD',KEYS[1])`;
export class RedisRateLimiter implements RateLimiter {
  async hit(key: string, windowMs: number) {
    const url = process.env.UPSTASH_REDIS_REST_URL,
      token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) throw new Error("Rate limiter unavailable");
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([
        "EVAL",
        script,
        "1",
        `customer:${key}`,
        String(windowMs),
        randomUUID(),
      ]),
      signal: AbortSignal.timeout(3000),
      cache: "no-store",
    });
    const result = await response.json();
    if (
      !response.ok ||
      result.error ||
      !Number.isSafeInteger(result.result) ||
      result.result < 1
    )
      throw new Error("Rate limiter unavailable");
    return result.result as number;
  }
}
export const rateLimiter: RateLimiter = new RedisRateLimiter();
export const scopes = {
  orderDeviceMinute: [3, 60000],
  orderDeviceHour: [20, 3600000],
  orderTable: [6, 300000],
  orderIp: [100, 600000],
  orderStore: [120, 600000],
  quoteDevice: [30, 60000],
  menuIp: [60, 60000],
  billToken: [12, 60000],
  billIp: [120, 60000],
  invalidIp: [20, 600000],
} as const;
export async function limit(
  scope: keyof typeof scopes,
  key: string,
  limiter = rateLimiter,
): Promise<boolean> {
  const [maximum, window] = scopes[scope];
  let count: number;
  try {
    count = await limiter.hit(`${scope}:${key}`, window);
  } catch {
    if (scope.startsWith("order")) return true;
    throw new AppError("RATE_LIMITED");
  }
  if (scope === "orderStore") return count > maximum;
  if (count > maximum) throw new AppError("RATE_LIMITED");
  return scope === "orderIp" && count > 20;
}
