import { DataError } from "../types";
import type * as Mock from "../mock/blocks-c";
const unavailable = async () => { throw new DataError("NOT_IMPLEMENTED", "未实现"); };
export const listBlockedClients: typeof Mock.listBlockedClients = unavailable;
export const unblockClient: typeof Mock.unblockClient = unavailable;
export const blockClientFromOrder: typeof Mock.blockClientFromOrder = unavailable;
export const blocksMockAction: typeof Mock.blocksMockAction = unavailable;
// M14/R12 rpc('list_blocked_clients', { p_include_expired: false }); R13 rpc('unblock_client', { p_block_id }); R9 rpc('block_client_from_order', { p_order_id, p_cancel: true, p_include_ip: false, p_days: 7 }).
