import { DataError, type CartItem, type CartQuote, type TableMenu } from '../types';
// C1 / C2：后端 PR3 实现，无外部请求。
export async function getTableMenu(_code: string): Promise<TableMenu> { throw new DataError('NOT_IMPLEMENTED', '未实现'); }
export async function quoteCart(_code: string, _items: CartItem[]): Promise<CartQuote> { throw new DataError('NOT_IMPLEMENTED', '未实现'); }
export function imageUrl(_path: string | null): string | null { throw new DataError('NOT_IMPLEMENTED', '未实现'); }
