import { DataError, type Session, type MyContext } from "../types";
import { createClient } from "../../supabase/client";
import { toAuthError } from "../../auth/gotrue-errors";
export async function getSession(): Promise<Session | null> {
  try {
    const client = createClient();
    const claims = await client.auth.getClaims();
    if (claims.error) {
      if (claims.error.name === "AuthSessionMissingError") return null;
      throw toAuthError(claims.error);
    }
    if (!claims.data?.claims) return null;
    const { data, error } = await client.rpc("get_my_context");
    if (error) throw toAuthError(error);
    if (!data) return null;
    const context = data as MyContext;
    return { ...context, user: { id: context.user_id, email: typeof claims.data.claims.email === "string" ? claims.data.claims.email : null, phone: typeof claims.data.claims.phone === "string" ? claims.data.claims.phone : null } };
  } catch (error) { throw error instanceof DataError ? error : toAuthError(error); }
}
export function onSessionChange(callback: (session: Session | null) => void): () => void {
  let active = true;
  const { data } = createClient().auth.onAuthStateChange(() => {
    // Run outside the Auth callback lock before making further Auth calls.
    setTimeout(() => { if (active) void getSession().then((session) => { if (active) callback(session); }).catch(() => { if (active) callback(null); }); }, 0);
  });
  return () => { active = false; data.subscription.unsubscribe(); };
}
