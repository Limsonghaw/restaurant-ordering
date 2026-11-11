/** 邮件支持本站绝对 URL；服务端使用部署站点配置，浏览器使用当前 origin。 */
export function safeNext(next: string | null): string {
  const origin =
    typeof window === "undefined"
      ? process.env.NEXT_PUBLIC_SITE_URL || "https://placeholder.invalid"
      : window.location.origin;
  if (!next || next.startsWith("//") || /[\\\u0000-\u0020]/.test(next))
    return "/store";
  try {
    const url = new URL(next, origin);
    if (url.origin !== new URL(origin).origin || url.username || url.password)
      return "/store";
    const p = url.pathname;
    if (/%(?:25|2f|5c|2e|0[0-9a-f]|1[0-9a-f]|20|7f)/i.test(p)) return "/store";
    return p === "/reset-password" ||
      p === "/set-password" ||
      p === "/store" ||
      p.startsWith("/store/")
      ? p + url.search
      : "/store";
  } catch {
    return "/store";
  }
}
