import { describe, expect, it, vi } from "vitest";
import worker from "../workers/production-menu";
import { customerHyperdriveConnection } from "../lib/supabase/customer-hyperdrive-context";

const { fetch } = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("vinext/server/fetch-handler", () => ({ default: { fetch } }));

describe("production menu worker", () => {
  it("selects the matching Hyperdrive binding and forwards other requests as before", async () => {
    const menuBinding = { connectionString: "test-menu-connection" };
    const orderBinding = { connectionString: "test-order-connection" };
    const ctx = {};
    const response = new Response(null, { status: 204 });
    fetch.mockImplementation(async () => {
      await Promise.resolve();
      return { response, connection: customerHyperdriveConnection.getStore() };
    });

    const both = { HYPERDRIVE: menuBinding, ORDER_HYPERDRIVE: orderBinding };
    for (const [method, path, env, connection] of [
      ["GET", "/api/t/code/menu", both, menuBinding.connectionString],
      ["GET", "/api/t/code/bill", both, menuBinding.connectionString],
      ["POST", "/api/t/code/quote", both, menuBinding.connectionString],
      ["POST", "/api/t/code/orders", both, orderBinding.connectionString],
      ["POST", "/api/t/code/orders", { HYPERDRIVE: menuBinding }, undefined],
      ["GET", "/api/t/code/orders", both, undefined],
      ["POST", "/api/t/code/menu", both, undefined],
      ["POST", "/api/t/code/bill", both, undefined],
      ["GET", "/api/t/code/quote", both, undefined],
      ["GET", "/store/tables", both, undefined],
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
