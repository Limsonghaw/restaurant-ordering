import {
  tableContext,
  customerError,
  json,
  type CustomerRouteContext,
} from "../../../../../lib/api/schemas";
import {
  device,
  trustedIp,
  cookie,
  billCookieName,
  secureCookie,
} from "../../../../../lib/client-context";
import { clientHash, sha256, requestHash } from "../../../../../lib/hash";
import { limit } from "../../../../../lib/ratelimit";
import { AppError } from "../../../../../lib/api/errors";
export const dynamic = "force-dynamic";
import { randomBytes } from "node:crypto";
import { customerPlaceOrder } from "../../../../../lib/supabase/customer";
import { cartBody } from "../../../../../lib/api/schemas";
import { verifyTurnstile } from "../../../../../lib/turnstile";
export async function POST(request: Request, context: CustomerRouteContext) {
  try {
    const table = await tableContext(request, context),
      did = device(request);
    if (!did) throw new AppError("VALIDATION_FAILED");
    const body = await cartBody(request, true);
    const device_hash = clientHash(table.store_id, did),
      ip_hash = clientHash(table.store_id, trustedIp(request));
    let required = false;
    for (const [scope, key] of [
      ["orderDeviceMinute", device_hash],
      ["orderDeviceHour", device_hash],
      ["orderTable", table.table_id],
      ["orderIp", ip_hash],
      ["orderStore", table.store_id],
    ] as const)
      required = (await limit(scope, key)) || required;
    // Always verify supplied tokens, including retries prompted by database require_captcha.
    const captcha_verified =
      required || body.captcha_token
        ? await verifyTurnstile(body.captcha_token)
        : false;
    const token = randomBytes(32).toString("base64url"),
      name = billCookieName(table.table_id),
      old = cookie(request, name);
    const result = await customerPlaceOrder({
      ...table,
      request_id: body.client_request_id,
      request_hash: requestHash(table.table_id, body.items),
      items: body.items,
      device_hash,
      ip_hash,
      bill_token_hash: old ? sha256(old) : null,
      new_bill_token_hash: sha256(token),
      captcha_verified,
    });
    const response = json(result, result.replayed ? 200 : 201);
    if (result.bill_token_issued)
      response.headers.append("Set-Cookie", secureCookie(name, token, 43200));
    return response;
  } catch (e) {
    return customerError(e, request);
  }
}
