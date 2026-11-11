import * as mock from "./mock/bills";
import * as real from "./supabase/bills";
const isMock = process.env.NEXT_PUBLIC_DATA_SOURCE === "mock";
export const { listBills, getBillDetail, markBillPaid } = isMock ? mock : real;
