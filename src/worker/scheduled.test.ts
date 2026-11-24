import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../env";

const harness = vi.hoisted(() => ({
  traffic: null as unknown,
  nodes: null as unknown,
  lifecycle: null as unknown,
  reconcile: null as unknown,
}));

vi.mock("../services/traffic", () => ({ runTrafficCollection: () => (harness.traffic as () => Promise<unknown>)() }));
vi.mock("../services/xui-node-sync", () => ({ runNodeSync: () => (harness.nodes as () => Promise<unknown>)() }));
vi.mock("../services/lifecycle", () => ({ runLifecycleMaintenance: () => (harness.lifecycle as () => Promise<unknown>)() }));
vi.mock("../services/xui-reconcile", () => ({ runEntitlementReconciliation: () => (harness.reconcile as () => Promise<unknown>)() }));

const { default: worker } = await import("./index");

describe("scheduled handler", () => {
  it("runs traffic, node, lifecycle and reconciliation work even when one job fails", async () => {
    const calls: string[] = [];
    harness.traffic = vi.fn(async () => { calls.push("traffic"); throw new Error("panel offline"); });
    harness.nodes = vi.fn(async () => { calls.push("nodes"); });
    harness.lifecycle = vi.fn(async () => { calls.push("lifecycle"); });
    harness.reconcile = vi.fn(async () => { calls.push("reconcile"); });
    const waits: Array<Promise<unknown>> = [];
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let logCalls: unknown[][] = [];

    try {
      worker.scheduled({} as ScheduledController, {} as RuntimeEnv, { waitUntil: (promise: Promise<unknown>) => waits.push(promise) } as unknown as ExecutionContext);
      await Promise.all(waits);
      logCalls = [...logged.mock.calls];
    } finally {
      logged.mockRestore();
    }

    expect(calls.sort()).toEqual(["lifecycle", "nodes", "reconcile", "traffic"]);
    expect(logCalls).toHaveLength(1);
    expect(String(logCalls[0]?.[0])).toContain("scheduled_job_failed");
  });
});
