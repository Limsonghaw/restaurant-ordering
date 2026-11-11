import { AppError, ERRORS, toErrorResponse } from "./errors";
import { uuidPattern, verifyTableCode } from "../qr";
import { trustedIp } from "../client-context";
import { clientHash } from "../hash";
import { limit } from "../ratelimit";
export interface CartLine {
  item_id: string;
  quantity: number;
  unit_price_cents: number;
  note: string;
}
export async function cartBody(request: Request, order = false) {
  if (
    request.headers.get("content-type")?.split(";")[0].trim() !==
    "application/json"
  )
    throw new AppError("UNSUPPORTED_MEDIA_TYPE");
  let b;
  try {
    b = await request.json();
  } catch {
    throw new AppError("VALIDATION_FAILED");
  }
  const invalid = () => {
    throw new AppError("VALIDATION_FAILED");
  };
  if (
    !b ||
    !Array.isArray(b.items) ||
    b.items.length < 1 ||
    b.items.length > 30
  )
    return invalid();
  const items: CartLine[] = b.items.map((i: CartLine) => {
    if (
      !i ||
      typeof i.item_id !== "string" ||
      !uuidPattern.test(i.item_id) ||
      !Number.isInteger(i.quantity) ||
      i.quantity < 1 ||
      i.quantity > 99 ||
      !Number.isInteger(i.unit_price_cents) ||
      i.unit_price_cents < 0 ||
      i.unit_price_cents > 999999 ||
      (i.note !== undefined &&
        (typeof i.note !== "string" || i.note.trim().length > 50))
    )
      return invalid();
    return {
      item_id: i.item_id.toLowerCase(),
      quantity: i.quantity,
      unit_price_cents: i.unit_price_cents,
      note: i.note?.trim() ?? "",
    };
  });
  if (items.reduce((n, i) => n + i.quantity, 0) > 200) return invalid();
  if (
    order &&
    (typeof b.client_request_id !== "string" ||
      !uuidPattern.test(b.client_request_id) ||
      (b.captcha_token !== undefined &&
        (typeof b.captcha_token !== "string" || b.captcha_token.length > 2048)))
  )
    return invalid();
  return {
    items,
    client_request_id: b.client_request_id as string,
    captcha_token: b.captcha_token as string | undefined,
  };
}
export type CustomerRouteContext = { params: Promise<{ code: string }> };
export async function tableContext(
  _request: Request,
  context: CustomerRouteContext,
) {
  const { code } = await context.params;
  const table = verifyTableCode(code);
  if (!table) throw new AppError("TABLE_INVALID");
  return table;
}
export async function customerError(error: unknown, request?: Request) {
  if (error instanceof AppError && error.code === "TABLE_INVALID" && request) {
    try {
      await limit("invalidIp", clientHash("invalid", trustedIp(request)));
    } catch (limited) {
      error = limited;
    }
  }
  const response = toErrorResponse(error);
  if (error instanceof AppError && "details" in error && error.details) {
    return Response.json(
      {
        error: {
          code: error.code,
          message: ERRORS[error.code].message,
          details: error.details,
        },
      },
      { status: response.status, headers: response.headers },
    );
  }
  return response;
}
export const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
