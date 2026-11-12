import type { CartItem, CartQuote } from "./data/types";

/** Local zero quote used when the cart is empty so the UI can show 0 without calling the API. */
export function emptyCartQuote(): CartQuote {
  return {
    can_order: false,
    is_accepting_orders: true,
    limit_exceeded: false,
    lines: [],
    item_count: 0,
    subtotal_cents: 0,
    unavailable: [],
    price_changes: [],
    max_order_cents: 300000,
    estimate_basis: "this_order",
    service_charge_bp: 0,
    sst_bp: 0,
    estimated_service_charge_cents: 0,
    estimated_sst_cents: 0,
    estimated_rounding_cents: 0,
    estimated_total_cents: 0,
  };
}

/**
 * Quote only when the cart is ready, the menu GET (which issues the did cookie)
 * has finished, and there is at least one line. The backend still requires both
 * a signed device cookie and items.length >= 1; this only avoids requesting
 * when those would fail for expected empty/first-load cases.
 */
export function shouldRequestQuote(
  cartReady: boolean,
  menuLoaded: boolean,
  cart: CartItem[],
) {
  return cartReady && menuLoaded && cart.length > 0;
}

export async function requestCartQuote(
  code: string,
  cart: CartItem[],
  fetchQuote: (code: string, items: CartItem[]) => Promise<CartQuote>,
): Promise<CartQuote> {
  if (cart.length === 0) return emptyCartQuote();
  return fetchQuote(code, cart);
}
