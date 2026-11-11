import type { PlaceOrderBody, PlaceOrderResult, TableBill } from "../types";
import { customerFetch } from "./customer-fetch";
export async function placeOrder(
  code: string,
  body: PlaceOrderBody,
): Promise<PlaceOrderResult> {
  return customerFetch(code, "orders", {
    client_request_id: body.client_request_id,
    items: body.items,
    captcha_token: body.turnstile_token ?? body.captcha_token,
  });
}
export async function getTableBill(code: string): Promise<TableBill> {
  return customerFetch(code, "bill");
}
