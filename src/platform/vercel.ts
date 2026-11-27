import app from "../app";
import { processEnv } from "./env";

/** Vercel Web Handler entry. The API function is mounted by api/index.ts. */
export default {
  fetch(request: Request): Response | Promise<Response> {
    return app.fetch(request, processEnv());
  },
};
