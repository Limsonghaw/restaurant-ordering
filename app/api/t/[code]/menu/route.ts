import {
  tableContext,
  customerError,
  json,
  type CustomerRouteContext,
} from "../../../../../lib/api/schemas";
import {
  device,
  trustedIp,
  secureCookie,
  issueDevice,
} from "../../../../../lib/client-context";
import { clientHash } from "../../../../../lib/hash";
import { limit } from "../../../../../lib/ratelimit";

export const dynamic = "force-dynamic";
import { customerGetMenu } from "../../../../../lib/supabase/customer";
export async function GET(request: Request, context: CustomerRouteContext) {
  try {
    const table = await tableContext(request, context);
    await limit("menuIp", clientHash(table.store_id, trustedIp(request)));
    const did = device(request);
    const response = json(await customerGetMenu(table));
    if (!did)
      response.headers.append(
        "Set-Cookie",
        secureCookie("did", issueDevice(), 31536000),
      );
    return response;
  } catch (e) {
    return customerError(e, request);
  }
}
