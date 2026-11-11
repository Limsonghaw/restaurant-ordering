import {
  tableContext,
  customerError,
  json,
  type CustomerRouteContext,
} from "../../../../../lib/api/schemas";
import { device } from "../../../../../lib/client-context";
import { clientHash } from "../../../../../lib/hash";
import { limit } from "../../../../../lib/ratelimit";
import { AppError } from "../../../../../lib/api/errors";
export const dynamic = "force-dynamic";
import { customerQuote } from "../../../../../lib/supabase/customer";
import { cartBody } from "../../../../../lib/api/schemas";
export async function POST(request: Request, context: CustomerRouteContext) {
  try {
    const table = await tableContext(request, context),
      did = device(request);
    if (!did) throw new AppError("VALIDATION_FAILED");
    const body = await cartBody(request);
    await limit("quoteDevice", clientHash(table.store_id, did));
    return json(await customerQuote(table, body.items));
  } catch (e) {
    return customerError(e, request);
  }
}
