import app from "../app";
import { platformEnv } from "./env";

interface EsaEnv extends Record<string, unknown> {
  Assets?: { fetch(request: Request): Promise<Response> };
}

/**
 * Alibaba Cloud ESA Edge Function entry.
 * /api/* goes to Hono; every other path is handed back to the ESA static asset module.
 */
export default {
  async fetch(request: Request, env?: EsaEnv): Promise<Response> {
    if (!new URL(request.url).pathname.startsWith("/api/")) {
      if (env?.Assets?.fetch) return env.Assets.fetch(request);
      return new Response("Not found", { status: 404 });
    }
    return app.fetch(request, platformEnv(env, "blob"));
  },
};
