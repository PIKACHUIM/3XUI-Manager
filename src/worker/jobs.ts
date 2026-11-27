import type { RuntimeEnv } from "../env";
import { runLifecycleMaintenance } from "../services/lifecycle";
import { runTrafficCollection } from "../services/traffic";
import { runEntitlementReconciliation } from "../services/xui-reconcile";
import { runNodeSync } from "../services/xui-node-sync";

export interface ScheduledJobsResult {
  status: "ok";
  jobs: Record<string, unknown>;
  errors: Array<{ job: string; message: string }>;
}

/**
 * Shared Cron entry point for Cloudflare, Vercel, EdgeOne and ESA.
 *
 * The traffic/lifecycle/reconcile/node jobs keep their existing storage guards:
 * D1-only work no-ops on Blob/KV/MySQL document stores, while the HTTP endpoint
 * still returns a successful, observable result.
 */
export async function runScheduledJobs(env: RuntimeEnv): Promise<ScheduledJobsResult> {
  const jobs: Array<[string, () => Promise<unknown>]> = [
    ["traffic", () => runTrafficCollection(env)],
    ["nodes", () => runNodeSync(env)],
    ["lifecycle", () => runLifecycleMaintenance(env)],
    ["reconcile", () => runEntitlementReconciliation(env)],
  ];
  const results: Record<string, unknown> = {};
  const errors: Array<{ job: string; message: string }> = [];
  await Promise.all(jobs.map(async ([name, run]) => {
    try {
      results[name] = await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      errors.push({ job: name, message });
      console.error(JSON.stringify({ event: "scheduled_job_failed", job: name, message }));
    }
  }));
  return { status: "ok", jobs: results, errors };
}
