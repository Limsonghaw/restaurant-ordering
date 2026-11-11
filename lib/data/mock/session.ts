import { sessionC } from "./auth-c";
import type { Session } from "../types";
import { delay } from "./state";
// M1 = rpc('get_my_context')
export async function getSession(): Promise<Session | null> {
  await delay();
  return sessionC();
}
export function onSessionChange(callback: (session: Session | null) => void) {
  const listener = () => {
    void getSession()
      .then(callback)
      .catch(() => callback(null));
  };
  window.addEventListener("ro-mock:change", listener);
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener("ro-mock:change", listener);
    window.removeEventListener("storage", listener);
  };
}
