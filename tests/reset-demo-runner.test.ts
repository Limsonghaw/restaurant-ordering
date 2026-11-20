import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signTableCode } from "../lib/qr";
import {
  MAX_ALLOWED_EMAILS, parseAllowedEmails, printTableUrls, readConfig, resetDemo,
} from "../scripts/reset-demo-data.mjs";

const store = "de000010-0000-4000-8000-000000000001";
const table = "de000010-0000-4000-8000-000000000010";
const manifest = JSON.parse(readFileSync(new URL("../scripts/demo-seed/manifest.json", import.meta.url), "utf8"));
const keys: string[] = manifest.objects.map(({ key }: { key: string }) => key);
const emails = Array.from({ length: MAX_ALLOWED_EMAILS + 1 }, (_, i) => `demo-${i}@example.invalid`);
const env = {
  DEMO_SUPABASE_URL: " https://fixture.supabase.co/ ",
  DEMO_ALLOWED_PROJECT_REF: " FiXtUrE ",
  DEMO_SUPABASE_SERVICE_ROLE_KEY: randomUUID(),
  DEMO_ALLOWED_USER_EMAILS: " DEMO@EXAMPLE.INVALID,\n demo@example.invalid\tother@example.invalid ",
  DEMO_SITE_URL: "https://demo.example.invalid",
  DEMO_QR_SIGNING_SECRET: randomUUID(),
};
const rpcResult = {
  store_id: store, public_table_id: table, stores: 1, tables: 3, categories: 4, items: 16, owners: 1,
  deleted: {
    blocked_clients: 0, order_items: 0, order_client_meta: 0, orders: 0,
    bill_access_tokens: 0, bills: 0, audit_logs: 0, stores: 0,
  },
};

afterEach(() => vi.unstubAllEnvs());

describe("demo reset runner", () => {
  it.each([
    { DEMO_SUPABASE_URL: "https://wrong.supabase.co" },
    { DEMO_SUPABASE_URL: "https://fixture.supabase.co//" },
    { DEMO_SUPABASE_URL: "https://fixture.supabase.co/path" },
    { DEMO_SUPABASE_URL: "https://fixture.supabase.co?query" },
    { DEMO_SUPABASE_URL: "https://user@fixture.supabase.co" },
    { DEMO_ALLOWED_PROJECT_REF: "bad-ref" },
    { DEMO_SUPABASE_SERVICE_ROLE_KEY: undefined },
    { DEMO_ALLOWED_USER_EMAILS: ", \n " },
    { DEMO_ALLOWED_USER_EMAILS: emails.join(",") },
    { DEMO_SITE_URL: "https://demo.example.invalid/" },
  ])("rejects invalid config before fetching (%j)", async (overrides) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(resetDemo({ ...env, ...overrides }, fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("normalizes the URL and emails and accepts exactly ten unique emails", () => {
    expect(readConfig(env)).toMatchObject({
      url: "https://fixture.supabase.co",
      emails: ["demo@example.invalid", "other@example.invalid"],
    });
    const ten = emails.slice(0, MAX_ALLOWED_EMAILS);
    expect(parseAllowedEmails([...ten, ten[0].toUpperCase()].join(", "))).toEqual(ten);
  });

  it("pages through nested folders, deletes only golden-store extras, then uploads and verifies", async () => {
    const extras = Array.from({ length: 101 }, (_, i) => `${store}/dirty/nested/old-${i}.png`);
    const outside = `${store}-other/items/leave.png`;
    const objects = new Set([...extras, outside, keys[0]]);
    const operations: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const { pathname, origin } = new URL(String(input));
      expect(origin).toBe("https://fixture.supabase.co");
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      // Boolean comparisons keep credentials out of assertion output.
      const headers = new Headers(init?.headers);
      expect(headers.get("apikey") === env.DEMO_SUPABASE_SERVICE_ROLE_KEY).toBe(true);
      expect(headers.get("Authorization") === "Bearer " + env.DEMO_SUPABASE_SERVICE_ROLE_KEY).toBe(true);

      if (pathname === "/rest/v1/rpc/reset_demo_data") {
        operations.push("rpc");
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          p_allowed_emails: ["demo@example.invalid", "other@example.invalid"],
        });
        return Response.json(rpcResult);
      }
      if (pathname === "/storage/v1/object/list/menu-images") {
        operations.push("list");
        const { prefix, offset, limit, sortBy } = JSON.parse(String(init?.body));
        expect(prefix === store || prefix.startsWith(store + "/")).toBe(true);
        expect(sortBy).toEqual({ column: "name", order: "asc" });
        const entries = new Map<string, string | null>();
        for (const key of objects) {
          if (!key.startsWith(prefix + "/")) continue;
          const [name, child] = key.slice(prefix.length + 1).split("/");
          entries.set(name, child ? null : "file-id");
        }
        return Response.json([...entries.keys()].sort().slice(offset, offset + limit)
          .map((name) => ({ name, id: entries.get(name) })));
      }
      if (init?.method === "DELETE") {
        operations.push("delete");
        expect(pathname).toBe("/storage/v1/object/menu-images");
        const { prefixes } = JSON.parse(String(init.body));
        for (const key of prefixes) {
          expect(extras).toContain(key);
          expect(objects.delete(key)).toBe(true);
        }
        return Response.json([]);
      }
      operations.push("upload");
      expect(init?.method).toBe("POST");
      const key = pathname.replace(/^\/storage\/v1\/object\/menu-images\//, "");
      const entry = manifest.objects.find((entry: { key: string }) => entry.key === key);
      expect(entry).toBeDefined();
      expect(headers.get("Content-Type")).toBe("image/png");
      expect(headers.get("x-upsert")).toBe("true");
      expect(init?.body).toEqual(readFileSync(new URL("../scripts/demo-seed/" + entry.file, import.meta.url)));
      objects.add(key);
      return Response.json({});
    });

    const summary = await resetDemo(env, fetcher);
    expect(summary).toMatchObject({
      stores: 1, tables: 3, categories: 4, items: 16, owners: 1,
      deleted_storage_keys: extras.sort(),
      public_table_url: printTableUrls(env),
    });
    expect([...objects].sort()).toEqual([...keys, outside].sort());
    expect(operations).toEqual([
      "rpc", ...Array(5).fill("list"), "delete", "delete", ...Array(keys.length).fill("upload"),
      "list", "list", "list",
    ]);
  });

  it.each([429, 200])("stops after a failed or unexpected RPC response (HTTP %i)", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...rpcResult, items: 15 }, { status }));
    await expect(resetDemo(env, fetcher)).rejects.toThrow(/Database reset failed|Unexpected database reset result/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports a post-commit Storage failure without surfacing response or transport details", async () => {
    const credentials = env.DEMO_SUPABASE_SERVICE_ROLE_KEY + env.DEMO_QR_SIGNING_SECRET;
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(rpcResult))
      .mockResolvedValueOnce(Response.json([]))
      .mockRejectedValueOnce(new Error(credentials));
    await expect(resetDemo(env, fetcher)).rejects.toThrow(
      /^Storage upload failed \(request error\) \(database reset already committed\)$/,
    );

    const denied = vi.fn<typeof fetch>().mockResolvedValue(new Response(credentials, { status: 403 }));
    await expect(resetDemo(env, denied)).rejects.toThrow(/^Database reset failed \(HTTP 403\)$/);
  });

  it("fails if the final listing does not contain the uploaded keys", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(rpcResult))
      .mockImplementation(async () => Response.json([]));
    await expect(resetDemo(env, fetcher)).rejects.toThrow(/database reset already committed/);
    expect(fetcher).toHaveBeenCalledTimes(keys.length + 3);
  });

  it("generates the public A1 link from signing config alone using the same code as the app", () => {
    vi.stubEnv("QR_SIGNING_SECRET", env.DEMO_QR_SIGNING_SECRET);
    const signed = signTableCode({ store_id: store, table_id: table, qr_version: 1 });
    expect(printTableUrls({
      DEMO_SITE_URL: env.DEMO_SITE_URL, DEMO_QR_SIGNING_SECRET: env.DEMO_QR_SIGNING_SECRET,
    })).toBe(`${env.DEMO_SITE_URL}/t/${signed}`);
    expect(() => printTableUrls({ ...env, DEMO_QR_SIGNING_SECRET: undefined }))
      .toThrow(/^Missing DEMO_QR_SIGNING_SECRET$/);
  });
});
