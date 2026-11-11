import * as mock from "./mock/tables";
import * as real from "./supabase/tables";
const isMock = process.env.NEXT_PUBLIC_DATA_SOURCE === "mock";
export const {
  listTables,
  createTable,
  updateTable,
  deleteTable,
  rotateTableQr,
} = isMock ? mock : real;
