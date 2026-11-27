import { processEnv } from "../src/platform/env";
import { runScheduledJobs } from "../src/worker/jobs";

export default {
  async fetch(request: Request): Promise<Response> {
    const env = processEnv();
    const secret = env.CRON_SECRET;
    if (!secret) return Response.json({ error: "CRON_SECRET is not configured." }, { status: 503 });
    const authorized = request.headers.get("authorization") === `Bearer ${secret}`
      || request.headers.get("x-cron-secret") === secret;
    if (!authorized) return Response.json({ error: "Forbidden." }, { status: 403 });
    return Response.json(await runScheduledJobs(env));
  },
};
