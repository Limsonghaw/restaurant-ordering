import { DataError, type Session } from '../types';
// M1 = rpc('get_my_context')；不另查 stores / profiles / store_members。
// 未来店家 stores 查询明确选择以下 21 列，不使用 *：
// id,slug,name,logo_path,address,opening_hours,is_accepting_orders,status,status_changed_at,currency,locale,timezone,service_charge_bp,sst_bp,cash_rounding,require_first_order_approval,max_order_cents,require_captcha,created_at,updated_at,is_profile_complete
export async function getSession(): Promise<Session | null> { throw new DataError('NOT_IMPLEMENTED', '未实现'); }
export function onSessionChange(_callback: (session: Session | null) => void): () => void { throw new DataError('NOT_IMPLEMENTED', '未实现'); }
