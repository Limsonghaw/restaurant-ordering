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
import { clientHash, sha256 } from "../../../../../lib/hash";
import { limit } from "../../../../../lib/ratelimit";

export const dynamic = "force-dynamic";
import { customerGetBill } from "../../../../../lib/supabase/customer";
export async function GET(request: Request, context: CustomerRouteContext) {
  let name: string | undefined;
  try {
    const table = await tableContext(request, context),
      did = device(request);
    name = billCookieName(table.table_id);
    const token = cookie(request, name);
    await limit("billIp", clientHash(table.store_id, trustedIp(request)));
    if (token) await limit("billToken", sha256(token));
    return json(
      await customerGetBill(
        table,
        token ? sha256(token) : null,
        did ? clientHash(table.store_id, did) : null,
      ),
    );
  } catch (e) {
    const response = await customerError(e, request);
    if (response.status === 410 && name)
      response.headers.append("Set-Cookie", secureCookie(name, "", 0));
    return response;
  }
}
