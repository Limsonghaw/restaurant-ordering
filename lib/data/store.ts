import * as mock from "./mock/store";
import * as real from "./supabase/store";
const isMock = process.env.NEXT_PUBLIC_DATA_SOURCE === "mock";
export const { getStore, updateStore } = isMock ? mock : real;
