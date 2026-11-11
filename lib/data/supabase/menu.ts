import { DataError, type CartItem, type CartQuote, type TableMenu } from '../types';
// C1 / C2：后端 PR3 实现，无外部请求。
export async function getTableMenu(_code: string): Promise<TableMenu> { throw new DataError('NOT_IMPLEMENTED', '未实现'); }
export async function quoteCart(_code: string, _items: CartItem[]): Promise<CartQuote> { throw new DataError('NOT_IMPLEMENTED', '未实现'); }
export function imageUrl(path: string | null): string | null {
  // Only relative Storage object paths; never resolve caller-provided URLs.
  if (!path || !/^[a-zA-Z0-9_-]+\/(?:items|logo)\/[a-zA-Z0-9_-]+\.(?:webp|jpe?g|png)$/.test(path)) return null;
  try {
    const base = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    if (!["https:", "http:"].includes(base.protocol)) return null;
    return `${base.origin}/storage/v1/object/public/menu-images/${path}`;
  } catch {
    return null;
  }
}
