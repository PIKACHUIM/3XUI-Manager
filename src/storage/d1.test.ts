import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import type { ClientMapping, Inbound, InboundNodeBinding, NodeRecord, User } from "../domain/types";
import type { RuntimeEnv } from "../env";
import { ThreeXuiClient } from "../adapters/xui/client";
import { runTrafficCollection } from "../services/traffic";
import { D1Store, calculateTrafficDelta, type TrafficSampleInput } from "./d1";

const require = createRequire(import.meta.url);
const { createD1TestPlatform } = require("./d1-test-platform.cjs") as {
  createD1TestPlatform: (configPath: string) => Promise<{ env: { DB: D1Database }; dispose: () => Promise<void> }>;
};

describe("calculateTrafficDelta", () => {
  it("uses the first sample only as a baseline", () => {
    expect(calculateTrafficDelta(null, 900, 1)).toEqual({ epoch: 0, deltaBytes: 0, billedBytes: 0 });
  });

  it("bills only the new counter delta using the current multiplier", () => {
    expect(calculateTrafficDelta({ epoch: 2, last_total_bytes: 1000, multiplier: 1.5 }, 1500, 1.5)).toEqual({ epoch: 2, deltaBytes: 500, billedBytes: 750 });
  });

  it("starts a new epoch after a counter reset", () => {
    expect(calculateTrafficDelta({ epoch: 2, last_total_bytes: 1000, multiplier: 2 }, 120, 2)).toEqual({ epoch: 3, deltaBytes: 120, billedBytes: 240 });
  });

  it("uses a multiplier edit as a new baseline", () => {
    expect(calculateTrafficDelta({ epoch: 2, last_total_bytes: 1000, multiplier: 1 }, 1500, 2)).toEqual({ epoch: 2, deltaBytes: 0, billedBytes: 0 });
  });

  it("rejects invalid counters and billed values", () => {
    expect(() => calculateTrafficDelta(null, -1, 1)).toThrow("Traffic sample values are invalid.");
    expect(() => calculateTrafficDelta({ epoch: 0, last_total_bytes: 0, multiplier: 2 }, Number.MAX_SAFE_INTEGER, 2)).toThrow("Billed traffic delta exceeds the safe integer range.");
  });
});

describe("D1Store traffic accounting", () => {
  let platform: Awaited<ReturnType<typeof createD1TestPlatform>>;
  let database: D1Database;
  let store: D1Store;

  beforeAll(async () => {
    platform = await createD1TestPlatform(fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)));
    database = platform.env.DB;
    for (const migrationUrl of ["../../migrations/0001_init.sql", "../../migrations/0002_usage_event_apply_state.sql", "../../migrations/0003_atomic_traffic_samples.sql", "../../migrations/0004_gib_units.sql"]) {
      const sql = await readFile(new URL(migrationUrl, import.meta.url), "utf8");
      const statements = sql.split(";").map((statement) => statement.trim()).filter((statement) => statement && !statement.startsWith("PRAGMA "));
      await database.batch(statements.map((statement) => database.prepare(statement)));
    }
    store = new D1Store(database as unknown as Env["DB"]);
  });

  afterAll(async () => {
    await platform?.dispose();
  });

  beforeEach(async () => {
    await database.batch([
      database.prepare("DELETE FROM traffic_counters"),
      database.prepare("DELETE FROM usage_events"),
      database.prepare("DELETE FROM app_records"),
    ]);
  });

  const sample = (totalBytes: number, occurredAt: string, multiplier = 1): TrafficSampleInput => ({
    userId: "user-1",
    nodeId: "node-1",
    inboundId: "inbound-1",
    clientKey: "client-1",
    totalBytes,
    multiplier,
    occurredAt,
    usageDay: "2026-11-14",
  });

  it("resolves a subscription token, its account and its plan in one batch", async () => {
    await store.put("plans", "plan-1", { id: "plan-1", enabled: true });
    await store.put("users", "user-1", { id: "user-1", planId: "plan-1", enabled: true, planTrafficBytes: 10, billedBytes: 1 });
    await store.put("subscription-credentials", "user-1", { userId: "user-1", tokenHash: "hash-1", encryptedToken: "x.y", updatedAt: "2026-01-01" });
    await store.put("subscription-token-index", "hash-1", { userId: "user-1" });

    const access = await store.readSubscriptionAccess("hash-1");
    expect(access?.user).toMatchObject({ id: "user-1", planId: "plan-1" });
    expect(access?.plan).toMatchObject({ id: "plan-1", enabled: true });
    expect(await store.readSubscriptionAccess("hash-missing")).toBeNull();

    // An index left behind by a failed rotation must not keep the old token alive.
    await store.put("subscription-credentials", "user-1", { userId: "user-1", tokenHash: "hash-2", encryptedToken: "x.y", updatedAt: "2026-01-01" });
    expect(await store.readSubscriptionAccess("hash-1")).toBeNull();
  });

  it("does not double bill overlapping samples and ignores an older sample", async () => {
    await store.recordTrafficSample(sample(1000, "2026-11-14T12:00:00.000Z"));
    const results = await Promise.all([
      store.recordTrafficSample(sample(1500, "2026-11-14T12:00:01.000Z")),
      store.recordTrafficSample(sample(1600, "2026-11-14T12:00:02.000Z")),
    ]);
    const usageEvents = await database.prepare("SELECT raw_bytes FROM usage_events").all<{ raw_bytes: number }>();
    expect(usageEvents.results?.reduce((sum, row) => sum + row.raw_bytes, 0)).toBe(600);
    expect(results.flatMap((event) => event ? [event] : []).reduce((sum, event) => sum + event.rawBytes, 0)).toBe(600);
    await store.recordTrafficSample(sample(1550, "2026-11-14T12:00:01.500Z"));
    const counter = await database.prepare("SELECT last_total_bytes FROM traffic_counters").first<{ last_total_bytes: number }>();
    expect(counter?.last_total_bytes).toBe(1600);
  });

  it("preserves usage on unrelated user patches and resets it with plan fields", async () => {
    await store.put("users", "user-1", {
      role: "user", planId: "old-plan", planLevel: 1, planTrafficBytes: 1000, billedBytes: 600,
      planStartedAt: "2026-11-14T00:00:00.000Z", planExpiresAt: null, trafficResetAt: null,
      updatedAt: "2026-11-14T00:00:00.000Z",
    });

    const rolePatched = await store.patchUser("user-1", { role: "admin" });
    expect(rolePatched).toMatchObject({ role: "admin", billedBytes: 600 });

    const planPatched = await store.patchUser("user-1", { planId: "new-plan", planLevel: 2, planTrafficBytes: 2000, billedBytes: 0 });
    expect(planPatched).toMatchObject({ role: "admin", planId: "new-plan", planLevel: 2, planTrafficBytes: 2000, billedBytes: 0, planStartedAt: "2026-11-14T00:00:00.000Z" });
  });

  it("applies each usage event once to the user and daily totals", async () => {
    await store.put("users", "user-1", { billedBytes: 0, planStartedAt: "2026-11-14T00:00:00.000Z", updatedAt: "2026-11-14T00:00:00.000Z" });
    await store.recordTrafficSample(sample(1000, "2026-11-14T12:00:00.000Z"));
    await store.recordTrafficSample(sample(1600, "2026-11-14T12:00:01.000Z"));
    const [first, second] = await Promise.all([store.applyPendingUsageEvents(), store.applyPendingUsageEvents()]);
    expect(first.events.length + second.events.length).toBe(1);
    expect((await store.get<{ billedBytes: number }>("users", "user-1"))?.billedBytes).toBe(600);
    expect(await store.get<{ rawBytes: number; billedBytes: number }>("daily-usage", "user-1:2026-11-14")).toMatchObject({ rawBytes: 600, billedBytes: 600 });
    const pending = await database.prepare("SELECT COUNT(*) AS count FROM usage_events WHERE applied_at IS NULL").first<{ count: number }>();
    expect(pending?.count).toBe(0);
  });

  it("deduplicates a replayed sample with the same timestamp and counter", async () => {
    await store.recordTrafficSample(sample(100, "2026-11-14T12:00:00.000Z"));
    const [first, replay] = await Promise.all([
      store.recordTrafficSample(sample(500, "2026-11-14T12:00:01.000Z")),
      store.recordTrafficSample(sample(500, "2026-11-14T12:00:01.000Z")),
    ]);
    expect([first, replay].filter(Boolean)).toHaveLength(1);
    const count = await database.prepare("SELECT COUNT(*) AS count FROM usage_events").first<{ count: number }>();
    expect(count?.count).toBe(1);
    expect((await database.prepare("SELECT raw_bytes FROM usage_events").first<{ raw_bytes: number }>())?.raw_bytes).toBe(400);
  });

  it("keeps an unassignable usage event pending until its user exists", async () => {
    await store.recordTrafficSample(sample(0, "2026-11-14T12:00:00.000Z"));
    await store.recordTrafficSample(sample(600, "2026-11-14T12:00:01.000Z"));
    expect(await store.applyPendingUsageEvents()).toMatchObject({ events: [], unapplied: 1 });
    await store.put("users", "user-1", { billedBytes: 0, planStartedAt: "2026-11-14T00:00:00.000Z", updatedAt: "2026-11-14T00:00:00.000Z" });
    expect(await store.applyPendingUsageEvents()).toMatchObject({ events: [{ billedBytes: 600 }], unapplied: 0 });
    expect((await store.get<{ billedBytes: number }>("users", "user-1"))?.billedBytes).toBe(600);
    expect((await store.applyPendingUsageEvents()).events).toHaveLength(0);
  });

  it("rejects billed counters beyond the safe-integer limit atomically", async () => {
    await store.recordTrafficSample(sample(0, "2026-11-14T12:00:00.000Z", 2));
    await expect(store.recordTrafficSample(sample(Number.MAX_SAFE_INTEGER, "2026-11-14T12:00:01.000Z", 2))).rejects.toThrow();
    const counter = await database.prepare("SELECT last_total_bytes, last_billed_bytes FROM traffic_counters").first<{ last_total_bytes: number; last_billed_bytes: number }>();
    expect(counter).toMatchObject({ last_total_bytes: 0, last_billed_bytes: 0 });
    const count = await database.prepare("SELECT COUNT(*) AS count FROM usage_events").first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it("debits and refunds the account balance without allowing an overdraft", async () => {
    const createdAt = "2026-11-14T00:00:00.000Z";
    await store.put("users", "user-1", { balanceMinor: 500, updatedAt: createdAt });
    const movement = { userId: "user-1", orderId: "order-1", amountMinor: 300, currency: "USD", createdAt };

    expect(await store.debitUserBalanceOnce(movement)).toBe(true);
    expect((await store.get<{ balanceMinor: number }>("users", "user-1"))?.balanceMinor).toBe(200);
    expect(await store.debitUserBalanceOnce(movement)).toBe(false);
    expect(await store.debitUserBalanceOnce({ ...movement, orderId: "order-2", amountMinor: 201 })).toBe(false);
    expect((await store.get<{ balanceMinor: number }>("users", "user-1"))?.balanceMinor).toBe(200);
    expect((await store.list("ledger-entries")).items).toEqual([
      expect.objectContaining({ id: "balance-payment:order-1", kind: "balance_payment", amountMinor: -300 }),
    ]);

    expect(await store.refundUserBalanceOnce(movement)).toBe(true);
    expect(await store.refundUserBalanceOnce(movement)).toBe(false);
    expect((await store.get<{ balanceMinor: number }>("users", "user-1"))?.balanceMinor).toBe(500);
    expect((await store.list("ledger-entries")).items).toHaveLength(2);
  });

  it("applies manual credits and deductions once per manual order", async () => {
    const createdAt = "2026-11-14T00:00:00.000Z";
    await store.put("users", "user-1", { balanceMinor: 500, updatedAt: createdAt });
    const movement = { userId: "user-1", orderId: "manual-1", amountMinor: 250, currency: "USD", createdAt, action: "credit" as const };

    expect(await store.adjustUserBalanceOnce(movement)).toBe(true);
    expect(await store.adjustUserBalanceOnce(movement)).toBe(false);
    expect((await store.get<{ balanceMinor: number }>("users", "user-1"))?.balanceMinor).toBe(750);
    expect(await store.adjustUserBalanceOnce({ ...movement, orderId: "manual-2", amountMinor: 800, action: "refund" })).toBe(false);
    expect((await store.get<{ balanceMinor: number }>("users", "user-1"))?.balanceMinor).toBe(750);
    expect(await store.adjustUserBalanceOnce({ ...movement, orderId: "manual-2", action: "refund" })).toBe(true);
    expect((await store.get<{ balanceMinor: number }>("users", "user-1"))?.balanceMinor).toBe(500);
    expect((await store.list("ledger-entries")).items).toEqual([
      expect.objectContaining({ id: "manual-credit:manual-1", kind: "manual_credit", amountMinor: 250 }),
      expect.objectContaining({ id: "manual-refund:manual-2", kind: "manual_refund", amountMinor: -250 }),
    ]);
    await expect(store.adjustUserBalanceOnce({ ...movement, amountMinor: 0 })).rejects.toThrow();
  });

  it("rotates sampling batches without duplicating nodes at the batch boundary", async () => {
    const now = new Date().toISOString();
    const nodes: NodeRecord[] = Array.from({ length: 10 }, (_, index) => ({
      id: `node-${String(index).padStart(2, "0")}`, name: `Node ${index}`, region: "test", panelUrl: "https://panel.example.test",
      publicAddress: `node-${index}.example.test`, username: "local", encryptedPassword: "", apiTokenEncrypted: null,
      basePath: "/", status: "online", supportedApi: true, lastCheckedAt: now, inboundCount: 1,
      syncStatus: "synced", lastSyncAt: now, lastError: null, enabled: true, createdAt: now, updatedAt: now,
    }));
    const inbound: Inbound = {
      id: "rotation-inbound", name: "Rotation inbound", protocol: "vless", network: "tcp", port: 443, minimumLevel: 0,
      multiplier: 1, enabled: true, config: {}, createdAt: now, updatedAt: now,
    };
    const bindings: InboundNodeBinding[] = nodes.map((node) => ({
      id: `${inbound.id}:${node.id}`, inboundId: inbound.id, nodeId: node.id, panelInboundId: 1, createdAt: now,
    }));
    await Promise.all([
      ...nodes.map((node) => store.put("nodes", node.id, node)),
      store.put("inbounds", inbound.id, inbound),
      ...bindings.map((binding) => store.put("inbound-node-bindings", binding.id, binding)),
    ]);

    const selected: string[] = [];
    const client = {
      listInbounds: vi.fn(async () => [{ id: 1 }]),
      readClientUsage: vi.fn(() => new Map()),
    };
    const connect = vi.spyOn(ThreeXuiClient, "connect").mockImplementation(async (_env, node) => {
      selected.push(node.id);
      return client as unknown as ThreeXuiClient;
    });
    const env = { STORAGE_DRIVER: "d1", DB: database } as unknown as RuntimeEnv;
    const nodeIds = nodes.map((node) => node.id);

    try {
      await runTrafficCollection(env);
      await runTrafficCollection(env);
      await runTrafficCollection(env);

      expect(selected.slice(0, 8)).toEqual(nodeIds.slice(0, 8));
      expect(selected.slice(8, 16)).toEqual([...nodeIds.slice(8), ...nodeIds.slice(0, 6)]);
      expect(selected.slice(16, 24)).toEqual([...nodeIds.slice(6), ...nodeIds.slice(0, 4)]);
    } finally {
      connect.mockRestore();
    }
  });

  it("disables quota-exhausted clients and retries a failed panel disable", async () => {
    const now = new Date().toISOString();
    const user: User = {
      id: "quota-user", email: "quota-user@example.test", passwordHash: "", emailVerifiedAt: null, role: "user", balanceMinor: 0,
      planId: "quota-plan", planLevel: 1, planExpiresAt: null, planTrafficBytes: 100, billedBytes: 0,
      planStartedAt: new Date(Date.now() - 60_000).toISOString(), trafficResetAt: null, enabled: true, inviteCode: null,
      invitedBy: null, inviteCount: 0, checkinStreak: 0, lastCheckinAt: null, lastActiveAt: null, createdAt: now, updatedAt: now,
      appliedPaymentIds: [],
    };
    const node: NodeRecord = {
      id: "quota-node", name: "Quota node", region: "test", panelUrl: "https://panel.example.test", publicAddress: "node.example.test",
      username: "local", encryptedPassword: "", apiTokenEncrypted: null, basePath: "/", status: "online", supportedApi: true,
      lastCheckedAt: now, inboundCount: 1, syncStatus: "synced", lastSyncAt: now, lastError: null, enabled: true,
      createdAt: now, updatedAt: now,
    };
    const inbound: Inbound = {
      id: "quota-inbound", name: "Quota inbound", protocol: "vless", network: "tcp", port: 443, minimumLevel: 0,
      multiplier: 1, enabled: true, config: {}, createdAt: now, updatedAt: now,
    };
    const binding: InboundNodeBinding = {
      id: `${inbound.id}:${node.id}`, inboundId: inbound.id, nodeId: node.id, panelInboundId: 1, createdAt: now,
    };
    const mapping: ClientMapping = {
      id: `${user.id}:${inbound.id}`, userId: user.id, inboundId: inbound.id, email: "quota-client", clientId: "quota-client-id",
      encryptedSecret: null, flow: "", enable: true, syncStatus: "synced", syncError: null, syncedNodes: [node.id],
      createdAt: now, updatedAt: now,
    };
    await Promise.all([
      store.put("users", user.id, user),
      store.put("nodes", node.id, node),
      store.put("inbounds", inbound.id, inbound),
      store.put("inbound-node-bindings", binding.id, binding),
      store.put("clients", mapping.id, mapping),
    ]);

    let totalBytes = 0;
    let disableAttempts = 0;
    const client = {
      listInbounds: vi.fn(async () => [{ id: binding.panelInboundId }]),
      readClientUsage: vi.fn(() => new Map([[mapping.email, totalBytes]])),
      disableClient: vi.fn(async () => {
        disableAttempts += 1;
        if (disableAttempts === 1) throw new Error("mock panel unavailable");
      }),
    };
    const connect = vi.spyOn(ThreeXuiClient, "connect").mockResolvedValue(client as unknown as ThreeXuiClient);
    const env = { STORAGE_DRIVER: "d1", DB: database } as unknown as RuntimeEnv;

    try {
      await runTrafficCollection(env);
      expect(connect).toHaveBeenCalledTimes(1);
      totalBytes = 150;
      await runTrafficCollection(env);

      expect(await store.get<User>("users", user.id)).toMatchObject({ billedBytes: 150 });
      expect(await store.get<ClientMapping>("clients", mapping.id)).toMatchObject({ enable: false, syncStatus: "failed", syncedNodes: [node.id] });
      expect(client.disableClient).toHaveBeenCalledTimes(1);

      await runTrafficCollection(env);

      expect(await store.get<ClientMapping>("clients", mapping.id)).toMatchObject({ enable: false, syncStatus: "synced", syncedNodes: [node.id] });
      expect(client.disableClient).toHaveBeenCalledTimes(2);
    } finally {
      connect.mockRestore();
    }
  });
});
