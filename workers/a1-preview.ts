import handler from "vinext/server/fetch-handler";
import { customerHyperdriveConnection } from "../lib/supabase/customer-hyperdrive-context";

export default {
  fetch(
    request: Request,
    env: { HYPERDRIVE: { connectionString: string } },
    ctx: unknown,
  ) {
    const { pathname } = new URL(request.url);
    if (
      request.method !== "GET" ||
      !/^(?:\/t\/[^/]+\/?|\/api\/t\/[^/]+\/menu|\/_next\/static\/.+)$/.test(
        pathname,
      )
    ) {
      return new Response(null, { status: 404 });
    }
    return customerHyperdriveConnection.run(env.HYPERDRIVE.connectionString, () =>
      handler.fetch(request, env, ctx),
    );
  },
};
