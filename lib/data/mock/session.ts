import type { Session } from "../types";
import { delay, readState } from "./state";
// M1 = rpc('get_my_context')
export async function getSession(): Promise<Session | null> {
  await delay();
  const s = readState().stores[0];
  const {
    id,
    slug,
    name,
    logo_path,
    status,
    status_changed_at,
    is_accepting_orders,
    is_profile_complete,
  } = s;
  return {
    user_id: "mock-owner",
    platform_role: "merchant",
    aal: "aal1",
    password_set: true,
    password_set_at: s.created_at,
    member_role: "owner",
    store: {
      id,
      slug,
      name,
      logo_path,
      status,
      status_changed_at,
      is_accepting_orders,
      is_profile_complete,
    },
    user: { id: "mock-owner", email: null, phone: null },
  };
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
