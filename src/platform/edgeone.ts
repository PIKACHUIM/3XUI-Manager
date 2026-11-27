import app from "../app";
import { platformEnv } from "./env";

/**
 * EdgeOne Makers Edge Functions entry (V8 / Web API runtime).
 * Blob or KV is selected through the platform bindings and STORAGE_DRIVER.
 */
export default {
  fetch(request: Request, env?: Record<string, unknown>): Response | Promise<Response> {
    return app.fetch(request, platformEnv(env, "blob"));
  },
};
