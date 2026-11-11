import type { MyContext } from "../types";
import { dataError, result } from "./pg-errors";

export async function getMyContext(): Promise<MyContext> {
  const context = await result<MyContext | null>((await getClient()).rpc("get_my_context"));
  if (!context) throw dataError("UNAUTHENTICATED");
  return context;
}
export async function storeContext(write = false): Promise<string> {
  const { store } = await getMyContext();
  if (!store) throw dataError("FORBIDDEN");
  if (write && store.status !== "active") throw dataError("STORE_SUSPENDED");
  return store.id;
}

// Load the browser SDK only when a real-data operation is invoked. Mock builds
// and mock-only Node tests can import the facade without initializing the SDK.
export async function getClient() {
  const { createClient } = await import("@/lib/supabase/client");
  return createClient();
}
