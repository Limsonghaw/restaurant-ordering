import { DataError } from "../types";
import type * as Mock from "../mock/blocks-c";
const unavailable = async () => { throw new DataError("NOT_IMPLEMENTED", "未实现"); };
export const listBlockedClients: typeof Mock.listBlockedClients = unavailable;
export const unblockClient: typeof Mock.unblockClient = unavailable;
export const blockClientFromOrder: typeof Mock.blockClientFromOrder = unavailable;
export const blocksMockAction: typeof Mock.blocksMockAction = unavailable;
// M14/R12 rpc('list_blocked_clients', { p_include_expired: false }); R13 rpc('unblock_client', { p_block_id }); R9 rpc('block_client_from_order', { p_order_id, p_cancel: true, p_include_ip: false, p_days: 7 }).
// R9：已结账返回 ORDER_BILL_CLOSED（mock 为 VALIDATION_FAILED），前端两者都当「这张订单已被处理」。
// 已上菜/已取消订单仍会拉黑但不取消，返回 { blocked: 1, cancelled: false }（mock 直接报错）。
// 返回值格式为 { blocked: number, cancelled: boolean }；mock 的 blocked 为布尔值。
