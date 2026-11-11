import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/** Proxy-only cookie bridge. Always apply refreshed cookies to the final response. */
export function createClient(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("请配置 Supabase 公开环境变量");
  const deadline = AbortSignal.timeout(5000);
  const cookies = new NextResponse().cookies;
  const supabase = createServerClient(url, key, {
    global: {
      fetch: (url, init) => {
        const signal = init?.signal
          ? AbortSignal.any([init.signal, deadline])
          : deadline;
        // Do not start another network request after auth-js retries past the deadline.
        signal.throwIfAborted();
        return fetch(url, { ...init, signal });
      },
    },
    cookieOptions: { sameSite: "lax", secure: process.env.NODE_ENV === "production" },
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(values) {
        values.forEach(({ name, value, options }) => {
          request.cookies.set(name, value);
          cookies.set(name, value, options);
        });
      },
    },
  });
  return {
    supabase,
    respond(response?: NextResponse) {
      const result = response ?? NextResponse.next({ request });
      cookies.getAll().forEach((cookie) => result.cookies.set(cookie));
      return result;
    },
  };
}
