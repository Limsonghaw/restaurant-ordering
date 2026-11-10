import * as mock from "./mock/live-orders";
import * as real from "./supabase/live-orders";
import * as mockControls from "./mock/controls-b";
import * as realControls from "./supabase/controls-b";
const isMock = process.env.NEXT_PUBLIC_DATA_SOURCE === "mock";
export const {
  listLiveOrders,
  listServedToday,
  fetchOrdersUpdatedSince,
  updateOrderStatus,
  getStoreStatus,
  setAcceptingOrders,
  subscribeStoreOrders,
} = isMock ? mock : real;
export const { getLiveMockSettings, configureLiveMock, runLiveMockAction } =
  isMock ? mockControls : realControls;
