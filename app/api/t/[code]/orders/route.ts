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
import {
  customerPlaceOrder,
  customerCheckReplay,
} from "../../../../../lib/supabase/customer";
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
    const token = randomBytes(32).toString("base64url"),
      name = billCookieName(table.table_id),
      old = cookie(request, name);
    const args = {
      ...table,
      request_id: body.client_request_id,
      request_hash: requestHash(table.table_id, body.items),
      items: body.items,
      device_hash,
      ip_hash,
      bill_token_hash: old ? sha256(old) : null,
      new_bill_token_hash: sha256(token),
      captcha_verified: false,
    };
    const probeDeviceRequiresCaptcha = await limit("orderProbeDevice", device_hash);
    const probeIpRequiresCaptcha = await limit("orderProbeIp", ip_hash);
    if (probeDeviceRequiresCaptcha || probeIpRequiresCaptcha) {
      if (!body.captcha_token)
        throw new AppError("CAPTCHA_REQUIRED", { scope: "probe" });
      args.captcha_verified = await verifyTurnstile(body.captcha_token, {
        table_id: table.table_id,
        request_id: body.client_request_id,
      });
    }
    const check = await customerCheckReplay(args);
    if (check.status === "mismatch") throw new AppError(check.code);
    let result;
    if (check.status === "replay") {
      result = await customerPlaceOrder(args);
    } else {
      let requiredScope: string | undefined;
      for (const [scope, key, detail] of [
        ["orderDeviceMinute", device_hash, "device"],
        ["orderDeviceHour", device_hash, "device"],
        ["orderTable", table.table_id, "table"],
        ["orderIp", ip_hash, "ip"],
        ["orderStore", table.store_id, "store"],
      ] as const)
        if (await limit(scope, key)) requiredScope ??= detail;
      if (requiredScope && !body.captcha_token)
        throw new AppError("CAPTCHA_REQUIRED", { scope: requiredScope });
      // Supplied tokens are always verified for new submissions.
      args.captcha_verified =
        args.captcha_verified ||
        (requiredScope || body.captcha_token
          ? await verifyTurnstile(body.captcha_token, {
              table_id: table.table_id,
              request_id: body.client_request_id,
            })
          : false);
      result = await customerPlaceOrder(args);
    }
    const response = json(result, result.replayed ? 200 : 201);
    if (result.bill_token_issued)
      response.headers.append("Set-Cookie", secureCookie(name, token, 43200));
    return response;
  } catch (e) {
    const response = await customerError(e, request);
    if (e instanceof AppError && e.code === "INTERNAL")
      return new Response(response.body, {
        status: 503,
        headers: response.headers,
      });
    return response;
  }
}
