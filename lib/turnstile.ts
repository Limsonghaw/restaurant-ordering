import { AppError } from "./api/errors";
export async function verifyTurnstile(token?: string): Promise<true> {
  if (!token) throw new AppError("CAPTCHA_REQUIRED");
  const key = process.env.TURNSTILE_SECRET_KEY;
  if (!key) throw new AppError("CAPTCHA_FAILED");
  try {
    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        body: new URLSearchParams({ secret: key, response: token }),
        signal: AbortSignal.timeout(5000),
      },
    );
    const data = await response.json();
    if (
      !response.ok ||
      data.success !== true ||
      data.action !== "place_order" ||
      data.hostname !== new URL(process.env.NEXT_PUBLIC_SITE_URL!).hostname
    )
      throw new Error();
    return true;
  } catch {
    throw new AppError("CAPTCHA_FAILED");
  }
}
