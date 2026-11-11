import { NextResponse, type NextRequest } from "next/server";
import { evaluateAccess, getAuthState } from "./lib/auth/guard";
import { createClient } from "./lib/supabase/middleware";
export async function proxy(request: NextRequest) {
  if (process.env.NEXT_PUBLIC_DATA_SOURCE === "mock")
    return NextResponse.next();
  let bridge: ReturnType<typeof createClient> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Auth deadline exceeded")),
        5000,
      );
    });
    bridge = createClient(request);
    const decision = await Promise.race([
      getAuthState(bridge.supabase).then((state) =>
        evaluateAccess(
          request.nextUrl.pathname + request.nextUrl.search,
          state,
        ),
      ),
      timeout,
    ]);
    return bridge.respond(
      decision.allow
        ? undefined
        : NextResponse.redirect(new URL(decision.to, request.url)),
    );
  } catch {
    const response = new NextResponse("服务暂时不可用", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
    return bridge ? bridge.respond(response) : response;
  } finally {
    clearTimeout(timer);
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
