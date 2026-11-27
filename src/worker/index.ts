import app from "../app";
import type { RuntimeEnv } from "../env";
import { runScheduledJobs } from "./jobs";

export default {
  fetch: app.fetch,
  scheduled(_controller: ScheduledController, env: RuntimeEnv, context: ExecutionContext) {
    context.waitUntil(runScheduledJobs(env));
  },
};
