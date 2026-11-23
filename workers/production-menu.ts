import handler from "vinext/server/fetch-handler";
import { customerHyperdriveConnection } from "../lib/supabase/customer-hyperdrive-context";

export default {
  fetch(
    request: Request,
    env: {
      HYPERDRIVE?: { connectionString: string };
      ORDER_HYPERDRIVE?: { connectionString: string };
    },
    ctx: unknown,
  ) {
    const { pathname } = new URL(request.url);
    const endpoint = /^\/api\/t\/[^/]+\/(menu|bill|quote|orders)\/?$/.exec(pathname)?.[1];
    const isMenuRequest =
      (request.method === "GET" && (endpoint === "menu" || endpoint === "bill")) ||
      (request.method === "POST" && endpoint === "quote");
    const binding = request.method === "POST" && endpoint === "orders"
      ? env.ORDER_HYPERDRIVE
      : isMenuRequest ? env.HYPERDRIVE : undefined;
    if (binding) {
      return customerHyperdriveConnection.run(binding.connectionString, () =>
        handler.fetch(request, env, ctx),
      );
    }
    return handler.fetch(request, env, ctx);
  },
};
