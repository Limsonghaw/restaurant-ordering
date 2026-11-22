import handler from "vinext/server/fetch-handler";
import { customerHyperdriveConnection } from "../lib/supabase/customer-hyperdrive-context";

export default {
  fetch(
    request: Request,
    env: { HYPERDRIVE: { connectionString: string } },
    ctx: unknown,
  ) {
    const { pathname } = new URL(request.url);
    const endpoint = /^\/api\/t\/[^/]+\/(menu|bill|quote)\/?$/.exec(pathname)?.[1];
    if (
      (request.method === "GET" && (endpoint === "menu" || endpoint === "bill")) ||
      (request.method === "POST" && endpoint === "quote")
    ) {
      return customerHyperdriveConnection.run(env.HYPERDRIVE.connectionString, () =>
        handler.fetch(request, env, ctx),
      );
    }
    return handler.fetch(request, env, ctx);
  },
};
