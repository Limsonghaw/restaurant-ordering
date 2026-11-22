import { describe, expect, it, vi } from "vitest";
import worker from "../workers/production-menu";
import { menuPreviewConnection } from "../lib/supabase/menu-preview-context";

const { fetch } = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("vinext/server/fetch-handler", () => ({ default: { fetch } }));

describe("production menu worker", () => {
  it("uses Hyperdrive for menu reads and forwards requests to the regular handler", async () => {
    const env = { HYPERDRIVE: { connectionString: "test-connection" } };
    const ctx = {};
    const response = new Response(null, { status: 204 });
    fetch.mockImplementation(async () => {
      await Promise.resolve();
      return { response, connection: menuPreviewConnection.getStore() };
    });

    for (const [method, path, connection] of [
      ["GET", "/api/t/code/menu", "test-connection"],
      ["POST", "/api/t/code/menu", undefined],
      ["POST", "/api/t/code/quote", undefined],
      ["POST", "/api/t/code/orders", undefined],
      ["GET", "/store/tables", undefined],
    ] as const) {
      const request = new Request(`https://example.com${path}`, { method });
      await expect(worker.fetch(request, env, ctx)).resolves.toEqual({
        response,
        connection,
      });
      expect(fetch).toHaveBeenLastCalledWith(request, env, ctx);
      expect(menuPreviewConnection.getStore()).toBeUndefined();
    }
  });
});
