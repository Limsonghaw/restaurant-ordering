import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { secret } from "./hash";
export function trustedIp(request: Request): string {
  const ip =
    request.headers.get("x-vercel-forwarded-for") ??
    request.headers.get("x-real-ip");
  return ip && isIP(ip.trim()) ? ip.trim() : "unknown";
}
export function cookie(request: Request, name: string): string | null {
  return (
    request.headers
      .get("cookie")
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${name}=`))
      ?.slice(name.length + 1) ?? null
  );
}
const mac = (v: string) =>
  createHmac("sha256", secret("DEVICE_COOKIE_SECRET")).update(v).digest();
export function issueDevice(): string {
  const payload = `v1.${randomBytes(16).toString("base64url")}`;
  return `${payload}.${mac(payload).toString("base64url")}`;
}
export function device(request: Request): string | null {
  const value = cookie(request, "did");
  if (!value || !/^v1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/.test(value))
    return null;
  const parts = value.split(".");
  const signature = Buffer.from(parts[2], "base64url");
  return signature.toString("base64url") === parts[2] &&
    timingSafeEqual(mac(`${parts[0]}.${parts[1]}`), signature)
    ? value
    : null;
}
export const billCookieName = (table: string) =>
  `bt_${table.replaceAll("-", "")}`;
export const secureCookie = (name: string, value: string, age: number) =>
  `${name}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/api/t; Max-Age=${age}`;
