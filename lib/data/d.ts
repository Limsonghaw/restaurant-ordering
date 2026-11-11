import * as mock from "./mock/store-d";
import * as bills from "./bills";
import * as tables from "./tables";
import * as store from "./store";
import { getStoreTableQrLinks as loadStoreTableQrLinks } from "./supabase/table-qr";
import { getStoreHistory as loadStoreHistory } from "./supabase/history";
import {
  DataError,
  type StoreBillFilters,
  type StoreBillDetail,
  type StoreBillPage,
  type StoreProfilePatch,
  type TableQrLink,
  type StoreHistory,
} from "./types";
const unavailable = async (): Promise<never> => {
  throw new DataError("NOT_IMPLEMENTED", "未实现");
};
const real = {
  listStoreBills: async (
    status: "open" | "paid",
    page = 1,
    filters: StoreBillFilters = {},
  ): Promise<StoreBillPage> => {
    const result = await bills.listBills({
      status,
      page,
      table_id: filters.table_id,
      paid_from: filters.paid_date,
      paid_to: filters.paid_date,
    });
    return {
      ...result,
      bills: result.bills.map((b) => ({
        ...b,
        is_estimate: b.is_estimate ?? b.status === "open",
      })),
    };
  },
  getStoreBill: async (id: string): Promise<StoreBillDetail> => {
    const { bill, orders } = await bills.getBillDetail(id);
    return {
      ...bill,
      orders,
      order_count: bill.order_count ?? orders.length,
      unserved_count:
        bill.unserved_count ??
        orders.filter((o) => o.status === "new" || o.status === "accepted")
          .length,
      is_estimate: bill.is_estimate ?? bill.status === "open",
    };
  },
  listStoreTables: tables.listTables,
  createStoreTable: tables.createTable,
  renameStoreTable: (id: string, label: string) =>
    tables.updateTable(id, { label }),
  softDeleteStoreTable: tables.deleteTable,
  setStoreTableActive: (id: string, is_active: boolean) =>
    tables.updateTable(id, { is_active }),
  rotateStoreTableQr: tables.rotateTableQr,
  getStoreProfile: store.getStore,
  saveStoreProfile: async (patch: StoreProfilePatch) => {
    await store.updateStore(patch);
    return store.getStore();
  },
  getStoreTableQrLinks: (ids: string[]): Promise<TableQrLink[]> =>
    loadStoreTableQrLinks(ids),
  getStoreHistory: (date: string): Promise<StoreHistory> =>
    loadStoreHistory(date),
  storeMockActionD: unavailable,
  checkoutMockBill: unavailable,
} satisfies typeof mock;
export const {
  setStoreTableActive,
  listStoreBills,
  getStoreBill,
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
