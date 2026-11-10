import { DataError, type LiveOrder, type OrderStatusChange, type LiveStoreStatus, type StoreOrderCallbacks } from "../types";
function missing(): never { throw new DataError("NOT_IMPLEMENTED", "未实现"); }
// M9：显式列名，禁止 select('*')。
export async function listLiveOrders(): Promise<LiveOrder[]> { return missing(); }
// from('orders').select('id,store_id,table_id,bill_id,seq_in_bill,device_seq_in_bill,status,subtotal_cents,item_count,created_at,accepted_at,served_at,cancelled_at,updated_at,cancel_reason,cancel_note,order_items(item_name,unit_price_cents,quantity,line_total_cents,note),dining_tables(label)').eq('store_id', 本店).eq('status','served').gte('served_at', 今天00:00 UTC+8).lt('served_at', 明天00:00 UTC+8).order('served_at',{ascending:false})
export async function listServedToday(): Promise<LiveOrder[]> { return missing(); }
// M9 补拉
export async function fetchOrdersUpdatedSince(_since: string): Promise<LiveOrder[]> { return missing(); }
// R1: p_order_id / p_to / p_expected / p_cancel_reason / p_cancel_note
export async function updateOrderStatus(_order_id: string, _change: OrderStatusChange): Promise<LiveOrder> { return missing(); }
// M2: select('name, status, is_accepting_orders')，不读 status_reason。
export async function getStoreStatus(): Promise<LiveStoreStatus> { return missing(); }
// M3
export async function setAcceptingOrders(_value: boolean): Promise<LiveStoreStatus> { return missing(); }
// M10：私有频道 store:{id}
export function subscribeStoreOrders(_store_id: string, _callbacks: StoreOrderCallbacks): () => void { return missing(); }
