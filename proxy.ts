import { NextResponse, type NextRequest } from "next/server";
import { evaluateAccess, type AuthState } from "./lib/auth/guard";
import { DataError } from "./lib/data/types";
// Backend PR2 supplies getAuthState via getClaims() + get_my_context.
// Mock identity lives in browser storage; it must never be read by proxy.
async function pendingAuthState(): Promise<AuthState> {
  throw new DataError("NOT_IMPLEMENTED", "未实现");
}
export async function proxy(request: NextRequest) {
  if (process.env.NEXT_PUBLIC_DATA_SOURCE === "mock")
    return NextResponse.next();
  try {
    const decision = evaluateAccess(
      request.nextUrl.pathname,
      await pendingAuthState(),
    );
    return decision.allow
      ? NextResponse.next()
      : NextResponse.redirect(new URL(decision.to, request.url));
  } catch {
    return new NextResponse("未实现", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
export const config = {
  matcher: [
    "/store/:path*",
    "/admin/:path*",
    "/login",
    "/register",
    "/forgot-password",
    "/verify",
    "/auth/confirm",
    "/set-password",
    "/reset-password",
  ],
};
