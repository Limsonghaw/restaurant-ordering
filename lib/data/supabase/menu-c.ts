import { DataError } from "../types";
import type * as Mock from "../mock/menu-c";
const unavailable = async () => { throw new DataError("NOT_IMPLEMENTED", "未实现"); };
export const getMenuForStore: typeof Mock.getMenuForStore = unavailable;
export const createCategory: typeof Mock.createCategory = unavailable;
export const renameCategory: typeof Mock.renameCategory = unavailable;
export const setCategoryHidden: typeof Mock.setCategoryHidden = unavailable;
export const deleteCategory: typeof Mock.deleteCategory = unavailable;
export const reorderCategories: typeof Mock.reorderCategories = unavailable;
export const reorderItems: typeof Mock.reorderItems = unavailable;
export const createItem: typeof Mock.createItem = unavailable;
export const updateItem: typeof Mock.updateItem = unavailable;
export const setItemSoldOut: typeof Mock.setItemSoldOut = unavailable;
export const setItemHidden: typeof Mock.setItemHidden = unavailable;
export const deleteItem: typeof Mock.deleteItem = unavailable;
export const uploadItemImage: typeof Mock.uploadItemImage = unavailable;
// M4 store columns: id,slug,name,logo_path,address,opening_hours,is_accepting_orders,status,status_changed_at,currency,locale,timezone,service_charge_bp,sst_bp,cash_rounding,require_first_order_approval,max_order_cents,require_captcha,created_at,updated_at,is_profile_complete. Never select *.
