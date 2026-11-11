import { beforeEach, afterEach, expect, it, vi } from "vitest";
const rpc = vi.hoisted(() => ({ customerGetBill: vi.fn() }));
vi.mock("../lib/supabase/customer", () => rpc);
import { GET } from "../app/api/t/[code]/bill/route";
import { AppError } from "../lib/api/errors";
import { signTableCode } from "../lib/qr";
import { issueDevice, billCookieName } from "../lib/client-context";
import { MemoryRateLimiter, rateLimiter } from "../lib/ratelimit";
const table = {
  store_id: "11111111-1111-4111-8111-111111111111",
  table_id: "22222222-2222-4222-8222-222222222222",
  qr_version: 1,
};
let code: string, did: string;
beforeEach(() => {
  vi.stubEnv("QR_SIGNING_SECRET", "test-qr");
  vi.stubEnv("DEVICE_COOKIE_SECRET", "test-device");
  vi.stubEnv("CLIENT_HASH_SECRET", "test-hash");
  code = signTableCode(table);
  did = issueDevice();
  const memory = new MemoryRateLimiter();
  vi.spyOn(rateLimiter, "hit").mockImplementation((k, w) => memory.hit(k, w));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const poll = (token = false) =>
  GET(
    new Request("https://site.example.invalid/api/t/code/bill", {
      headers: {
        cookie: `did=${did}${token ? `; ${billCookieName(table.table_id)}=test-token` : ""}`,
        "x-vercel-forwarded-for": "192.0.2.4",
      },
    }),
    { params: Promise.resolve({ code }) },
  );
it.each(["qr_rotated", "bill_paid", "expired"])(
  "410 %s clears cookie on 25 polls without invalidIp throttling",
  async (reason) => {
    rpc.customerGetBill.mockRejectedValue(
      new AppError("BILL_TOKEN_EXPIRED", { reason }),
    );
    for (let i = 0; i < 25; i++) {
      // The browser applies the first 410 Set-Cookie before the next poll.
      const r = await poll(i === 0);
      expect(r.status).toBe(410);
      expect(r.headers.get("set-cookie")).toContain("Max-Age=0");
      expect((await r.json()).error.details).toEqual({ reason });
    }
  },
);
it("404 reaches invalidIp limit on poll 21", async () => {
  rpc.customerGetBill.mockRejectedValue(new AppError("TABLE_INVALID"));
  for (let i = 0; i < 21; i++)
    expect((await poll()).status).toBe(i < 20 ? 404 : 429);
});
