import { DataError, type PlaceOrderBody, type PlaceOrderResult, type TableBill } from '../types';
// C3 / C4：后端 PR3 实现。
export async function placeOrder(_code: string, _body: PlaceOrderBody): Promise<PlaceOrderResult> { throw new DataError('NOT_IMPLEMENTED', '未实现'); }
export async function getTableBill(_code: string): Promise<TableBill> { throw new DataError('NOT_IMPLEMENTED', '未实现'); }
