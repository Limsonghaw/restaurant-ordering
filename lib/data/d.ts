import * as mock from "./mock/store-d";
import { DataError } from "./types";
// PR4 provides real merchant adapters. Keep the placeholder outside protected supabase files.
const unavailable = async (): Promise<never> => {
  throw new DataError("NOT_IMPLEMENTED", "未实现");
};
const real: typeof mock = {
  listStoreBills: unavailable,
  getStoreBill: unavailable,
  markBillPaid: unavailable,
  listStoreTables: unavailable,
  createStoreTable: unavailable,
  renameStoreTable: unavailable,
  softDeleteStoreTable: unavailable,
  rotateStoreTableQr: unavailable,
  getStoreTableQrLinks: unavailable,
  getStoreProfile: unavailable,
  saveStoreProfile: unavailable,
  getStoreHistory: unavailable,
  storeMockActionD: unavailable,
};
export const {
  listStoreBills,
  getStoreBill,
  markBillPaid,
  listStoreTables,
  createStoreTable,
  renameStoreTable,
  softDeleteStoreTable,
  rotateStoreTableQr,
  getStoreTableQrLinks,
  getStoreProfile,
  saveStoreProfile,
  getStoreHistory,
  storeMockActionD,
} = process.env.NEXT_PUBLIC_DATA_SOURCE === "mock" ? mock : real;
