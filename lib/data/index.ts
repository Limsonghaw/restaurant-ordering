import * as mockMenu from "./mock/menu";
import * as realMenu from "./supabase/menu";
import * as mockOrders from "./mock/orders";
import * as realOrders from "./supabase/orders";
import * as mockSession from "./mock/session";
import * as realSession from "./supabase/session";
import * as mockControls from "./mock/controls-a";
import * as realControls from "./supabase/controls-a";
export const isMock = process.env.NEXT_PUBLIC_DATA_SOURCE === "mock";
export const { getTableMenu, quoteCart, imageUrl } = isMock
  ? mockMenu
  : realMenu;
export const { placeOrder, getTableBill } = isMock ? mockOrders : realOrders;
export const { getSession, onSessionChange } = isMock
  ? mockSession
  : realSession;
export const { getMockSnapshot, configureMock, runMockAction } = isMock
  ? mockControls
  : realControls;
export * from "./types";

export * from "./c";
