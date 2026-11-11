import type { SupabaseClient } from "@supabase/supabase-js";
import type { MyContext, StoreStatus } from "../data/types";
import { safeNext } from "./safe-next";
export type AuthState =
  | {
      kind:
        | "anonymous"
        | "needs_mfa"
        | "platform_admin"
        | "no_store"
        | "needs_password";
    }
  | {
      kind: "ready";
      storeId: string;
      storeStatus: StoreStatus;
      isProfileComplete: boolean;
    };
export type AccessDecision = { allow: true } | { allow: false; to: string };
export function toAuthState(ctx: MyContext | null): AuthState {
  if (ctx === null) return { kind: "anonymous" };
  if (
    typeof ctx !== "object" ||
    Array.isArray(ctx) ||
    ![null, "merchant", "platform_admin"].includes(ctx.platform_role) ||
    !["aal1", "aal2"].includes(ctx.aal) ||
    (ctx.store !== null &&
      (typeof ctx.store !== "object" ||
        Array.isArray(ctx.store) ||
        !ctx.store ||
        typeof ctx.store.id !== "string" ||
        !ctx.store.id.trim() ||
        !["active", "suspended", "pending_review"].includes(ctx.store.status)))
  )
    throw new Error("Invalid get_my_context response");
  if (ctx.platform_role === "platform_admin")
    return { kind: ctx.aal === "aal2" ? "platform_admin" : "needs_mfa" };
  if (!ctx.store) return { kind: "no_store" };
  if (!ctx.password_set_at) return { kind: "needs_password" };
  return {
    kind: "ready",
    storeId: ctx.store.id,
    storeStatus: ctx.store.status,
    isProfileComplete: ctx.store.is_profile_complete,
  };
}
export function evaluateAccess(
  pathname: string,
  state: AuthState,
): AccessDecision {
  const p = pathname.split("?")[0];
  if (["/login", "/register", "/forgot-password", "/auth/confirm"].includes(p))
    return { allow: true };
  const store = p === "/store" || p.startsWith("/store/");
  const admin = p === "/admin" || p.startsWith("/admin/");
  if (
    !store &&
    !admin &&
    !["/verify", "/set-password", "/reset-password"].includes(p)
  )
    return { allow: true };
  const redirect = (to: string): AccessDecision => ({ allow: false, to });
  switch (state.kind) {
    case "anonymous":
      return p === "/verify"
        ? { allow: true }
        : redirect(`/login?next=${encodeURIComponent(safeNext(pathname))}`);
    case "needs_mfa":
      return p === "/admin/mfa" ? { allow: true } : redirect("/admin/mfa");
    case "platform_admin":
      return admin && p !== "/admin/mfa" ? { allow: true } : redirect("/admin");
    case "no_store":
      return p === "/verify" ? { allow: true } : redirect("/verify");
    case "needs_password":
      return ["/set-password", "/reset-password"].includes(p)
        ? { allow: true }
        : redirect(
            `/set-password?next=${encodeURIComponent(safeNext(pathname))}`,
          );
    case "ready":
      return admin || p === "/verify" ? redirect("/store") : { allow: true };
  }
}

export async function getAuthState(
  supabase: SupabaseClient,
): Promise<AuthState> {
  const { data, error } = await supabase.auth.getClaims();
  if (error) {
    if (error.name === "AuthSessionMissingError") return { kind: "anonymous" };
    throw error;
  }
  if (!data?.claims) return { kind: "anonymous" };
  const context = await supabase.rpc("get_my_context");
  if (context.error) throw context.error;
  return toAuthState(context.data as MyContext | null);
}
