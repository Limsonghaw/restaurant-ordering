import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { secret } from "./hash";
// Production supports Vercel only: it overwrites x-vercel-forwarded-for.
// Never trust client-supplied x-real-ip outside local development/tests.
export function trustedIp(request: Request): string {
  const ip =
    request.headers.get("x-vercel-forwarded-for") ??
    (process.env.NODE_ENV !== "production" &&
    process.env.VERCEL_ENV !== "production" &&
    process.env.TRUST_LOCAL_IP === "1"
      ? (request.headers.get("x-forwarded-for")?.split(",")[0] ??
        request.headers.get("x-real-ip"))
      : ["development", "test"].includes(process.env.NODE_ENV ?? "") &&
          process.env.VERCEL_ENV !== "production"
        ? request.headers.get("x-real-ip")
        : null);
  if (!ip || ip.includes("%") || !isIP(ip.trim())) return "unknown";
  const value = ip.trim();
  if (isIP(value) === 4) return value;
  // URL canonicalizes compressed IPv6 and dotted IPv4 suffixes without DNS.
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  const halves = canonical.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const words =
    halves.length === 2
      ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
      : left;
  const n = words.map((w) => parseInt(w, 16));
  if (n.slice(0, 5).every((w) => w === 0) && n[5] === 65535)
    return [n[6] >> 8, n[6] & 255, n[7] >> 8, n[7] & 255].join(".");
  return (
    n
      .slice(0, 4)
      .map((w) => w.toString(16))
      .join(":") + "::/64"
  );
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
