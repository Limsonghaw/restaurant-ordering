import { DataError, type ErrorCode } from "../types";
export async function customerFetch<T>(
  code: string,
  endpoint: string,
  body?: unknown,
): Promise<T> {
  try {
    const response = await fetch(
      `/api/t/${encodeURIComponent(code)}/${endpoint}`,
      {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        cache: "no-store",
        ...(body === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
      },
    );
    let data;
    try {
      data = await response.json();
    } catch {
      throw new DataError(
        (response.status === 413 ? "PAYLOAD_TOO_LARGE" : "INTERNAL") as ErrorCode,
        response.status === 413 ? "请求内容超过 16 KB" : "请求失败",
        {}, response.status,
      );
    }
    if (!response.ok)
      throw new DataError(
        data.error?.code as ErrorCode,
        data.error?.message ?? "请求失败",
        data.error?.details ?? {},
        response.status,
        Number(response.headers.get("Retry-After")) || 0,
      );
    return data as T;
  } catch (error) {
    if (error instanceof DataError) throw error;
    throw new DataError("NETWORK", "网络出错，请重试", {}, 503);
  }
}
