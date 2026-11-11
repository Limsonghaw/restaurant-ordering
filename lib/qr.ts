import { createHmac, timingSafeEqual } from "node:crypto";
import { secret } from "./hash";
export interface TableCode {
  store_id: string;
  table_id: string;
  qr_version: number;
}
export const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const mac = (value: string) =>
  createHmac("sha256", secret("QR_SIGNING_SECRET"))
    .update(value)
    .digest()
    .subarray(0, 16);
function uuid(bytes: Buffer) {
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export function signTableCode(value: TableCode): string {
  if (
    !uuidPattern.test(value.store_id) ||
    !uuidPattern.test(value.table_id) ||
    !Number.isInteger(value.qr_version) ||
    value.qr_version < 0 ||
    value.qr_version > 65535
  )
    throw new Error("Invalid table code input");
  const bytes = Buffer.alloc(34);
  Buffer.from(value.store_id.replaceAll("-", ""), "hex").copy(bytes);
  Buffer.from(value.table_id.replaceAll("-", ""), "hex").copy(bytes, 16);
  bytes.writeUInt16BE(value.qr_version, 32);
  const payload = `v1.${bytes.toString("base64url")}`;
  return `${payload}.${mac(payload).toString("base64url")}`;
}
export function verifyTableCode(code: string): TableCode | null {
  if (!/^v1\.[A-Za-z0-9_-]{46}\.[A-Za-z0-9_-]{22}$/.test(code)) return null;
  const [v, data, signature] = code.split(".");
  const bytes = Buffer.from(data, "base64url"),
    sig = Buffer.from(signature, "base64url");
  if (
    bytes.toString("base64url") !== data ||
    sig.toString("base64url") !== signature ||
    !timingSafeEqual(mac(`${v}.${data}`), sig)
  )
    return null;
  return {
    store_id: uuid(bytes.subarray(0, 16)),
    table_id: uuid(bytes.subarray(16, 32)),
    qr_version: bytes.readUInt16BE(32),
  };
}
