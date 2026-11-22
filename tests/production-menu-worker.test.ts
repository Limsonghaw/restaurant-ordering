import { describe, expect, it, vi } from "vitest";
import worker from "../workers/production-menu";
import { customerHyperdriveConnection } from "../lib/supabase/customer-hyperdrive-context";

const { fetch } = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("vinext/server/fetch-handler", () => ({ default: { fetch } }));

describe("production menu worker", () => {
  it("uses Hyperdrive for menu, quote, and bill requests and keeps other routes on the regular path", async () => {
    const env = { HYPERDRIVE: { connectionString: "test-connection" } };
    const ctx = {};
    const response = new Response(null, { status: 204 });
    fetch.mockImplementation(async () => {
      await Promise.resolve();
      return { response, connection: customerHyperdriveConnection.getStore() };
    });

    for (const [method, path, connection] of [
      ["GET", "/api/t/code/menu", "test-connection"],
      ["GET", "/api/t/code/bill", "test-connection"],
      ["POST", "/api/t/code/quote", "test-connection"],
      ["POST", "/api/t/code/menu", undefined],
      ["POST", "/api/t/code/bill", undefined],
      ["GET", "/api/t/code/quote", undefined],
      ["POST", "/api/t/code/orders", undefined],
      ["GET", "/store/tables", undefined],
    ] as const) {
      const request = new Request(`https://example.com${path}`, { method });
      await expect(worker.fetch(request, env, ctx)).resolves.toEqual({
        response,
        connection,
      });
      expect(fetch).toHaveBeenLastCalledWith(request, env, ctx);
      expect(customerHyperdriveConnection.getStore()).toBeUndefined();
    }
  });
});
