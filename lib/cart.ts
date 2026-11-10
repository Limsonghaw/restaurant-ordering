import type { CartItem } from "./data/types";
export function readCart(code: string): CartItem[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(`cart:${code}`) ?? "[]",
    );
    return Array.isArray(value)
      ? value
          .filter(
            (i): i is CartItem =>
              typeof i.item_id === "string" &&
              Number.isInteger(i.quantity) &&
              i.quantity >= 1 &&
              i.quantity <= 99 &&
              typeof i.note === "string" &&
              i.note.length <= 50 &&
              Number.isInteger(i.unit_price_cents),
          )
          .slice(0, 30)
      : [];
  } catch {
    return [];
  }
}
export function writeCart(code: string, items: CartItem[]) {
  localStorage.setItem(
    `cart:${code}`,
    JSON.stringify(
      items.map(({ item_id, quantity, note, unit_price_cents }) => ({
        item_id,
        quantity,
        note,
        unit_price_cents,
      })),
    ),
  );
}
export function addCartLine(
  items: CartItem[],
  line: CartItem,
): CartItem[] | null {
  const index = items.findIndex(
    (i) => i.item_id === line.item_id && i.note === line.note,
  );
  const next = items.map((i) => ({ ...i }));
  if (index >= 0) next[index].quantity += line.quantity;
  else next.push(line);
  return next.length > 30 ||
    next.some((i) => i.quantity > 99) ||
    next.reduce((n, i) => n + i.quantity, 0) > 200
    ? null
    : next;
}
