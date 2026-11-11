import { createClient } from "../../../../lib/supabase/server";
import { AppError, toErrorResponse } from "../../../../lib/api/errors";
import { toGoTrueError } from "../../../../lib/auth/gotrue-errors";
import { hasFreshVerification } from "../../../../lib/auth/reauth";
import { validPassword } from "../../../../lib/auth/validation";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const site = process.env.NEXT_PUBLIC_SITE_URL;
    const fetchSite = request.headers.get("sec-fetch-site");
    if (
      !site ||
      request.headers.get("origin") !== site ||
      (fetchSite !== null && fetchSite !== "same-origin")
    )
      throw new AppError("FORBIDDEN");
    if (
      !/^application\/json(?:\s*;|$)/i.test(
        request.headers.get("content-type") ?? "",
      )
    )
      throw new AppError("UNSUPPORTED_MEDIA_TYPE");
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new AppError("VALIDATION_FAILED");
    }
    if (
      !body ||
      typeof body !== "object" ||
      !("password" in body) ||
      typeof body.password !== "string" ||
      !validPassword(body.password)
    )
      throw new AppError("VALIDATION_FAILED");
    const supabase = await createClient();
    const { data, error } = await supabase.auth.getClaims();
    if (error) throw toGoTrueError(error);
    if (!data?.claims) throw new AppError("UNAUTHENTICATED");
    if (!hasFreshVerification(data.claims.amr))
      throw new AppError("REAUTH_REQUIRED");
    const update = await supabase.auth.updateUser({ password: body.password });
    if (update.error) throw toGoTrueError(update.error);
    const logout = await supabase.auth.signOut({ scope: "others" });
    if (logout.error) throw toGoTrueError(logout.error);
    return Response.json(
      { ok: true, next: "/store" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
