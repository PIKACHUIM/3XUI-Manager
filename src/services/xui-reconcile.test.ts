import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMapping, Inbound, InboundNodeBinding, User } from "../domain/types";
import type { RuntimeEnv } from "../env";
import type { DocumentStore, ListOptions, Page } from "../storage/store";
import type { SyncResult } from "./xui-sync";

const harness = vi.hoisted(() => ({
  store: null as unknown,
  sync: null as unknown,
}));

vi.mock("../storage/d1", () => ({
  D1Store: function MockD1Store(this: unknown) {
    return harness.store;
  } as unknown,
}));
vi.mock("./xui-sync", () => ({
  syncUserEntitlements: (store: DocumentStore, env: RuntimeEnv, userId: string) =>
    (harness.sync as (store: DocumentStore, env: RuntimeEnv, userId: string) => Promise<SyncResult>)(store, env, userId),
}));

const { runEntitlementReconciliation } = await import("./xui-reconcile");

class MemoryStore implements DocumentStore {
  private readonly records = new Map<string, Map<string, unknown>>();

  constructor(seed: Array<[string, string, unknown]>) {
    for (const [collection, id, value] of seed) {
      const records = this.records.get(collection) ?? new Map<string, unknown>();
      records.set(id, structuredClone(value));
      this.records.set(collection, records);
    }
  }

  async get<T>(collection: string, id: string): Promise<T | null> {
    return (this.records.get(collection)?.get(id) as T | undefined) ?? null;
  }

  async put<T>(collection: string, id: string, value: T): Promise<void> {
    const records = this.records.get(collection) ?? new Map<string, unknown>();
    records.set(id, structuredClone(value));
    this.records.set(collection, records);
  }

  async delete(collection: string, id: string): Promise<void> {
    this.records.get(collection)?.delete(id);
  }

  async list<T>(collection: string, options: ListOptions = {}): Promise<Page<T>> {
    const limit = options.limit ?? 50;
    const items = [...(this.records.get(collection) ?? new Map<string, unknown>()).entries()]
      .filter(([id]) => id > (options.cursor ?? "") && (!options.prefix || id.startsWith(options.prefix)))
      .sort(([left], [right]) => left.localeCompare(right));
    const page = items.slice(0, limit);
    return { items: page.map(([, value]) => structuredClone(value) as T), cursor: items.length > limit ? page.at(-1)?.[0] ?? null : null };
  }

  async has(collection: string, id: string): Promise<boolean> {
    return this.records.get(collection)?.has(id) ?? false;
  }

  async acquireLease(): Promise<boolean> {
    return true;
  }

  async releaseLease(): Promise<void> {}
}

const now = "2026-01-01T00:00:00.000Z";

function user(id: string, patch: Partial<User> = {}): User {
  return {
    id, email: `${id}@example.test`, passwordHash: "", emailVerifiedAt: null, role: "user", balanceMinor: 0,
    planId: "plan-a", planLevel: 1, planExpiresAt: null, planTrafficBytes: 10_000, billedBytes: 0,
    planStartedAt: now, trafficResetAt: null, enabled: true, inviteCode: null, invitedBy: null, inviteCount: 0,
    checkinStreak: 0, lastCheckinAt: null, lastActiveAt: null, createdAt: now, updatedAt: now, ...patch,
  };
}

const inbound: Inbound = {
  id: "inbound-1", name: "test", protocol: "vless", port: 443, network: "tcp", minimumLevel: 0,
  multiplier: 1, enabled: true, config: {}, createdAt: now, updatedAt: now,
};

function binding(nodeId: string, panelInboundId = 42): InboundNodeBinding {
  return { id: `${inbound.id}:${nodeId}`, inboundId: inbound.id, nodeId, panelInboundId, createdAt: now };
}

function mapping(userId: string, patch: Partial<ClientMapping> = {}): ClientMapping {
  return {
    id: `${userId}:${inbound.id}`, userId, inboundId: inbound.id, email: `u_${userId}`, clientId: `c_${userId}`,
    encryptedSecret: null, flow: "", enable: true, syncStatus: "synced", syncError: null, syncedNodes: ["node-1"],
    createdAt: now, updatedAt: now, ...patch,
  };
}

const env = { STORAGE_DRIVER: "d1", DB: {} } as unknown as RuntimeEnv;

beforeEach(() => {
  harness.sync = vi.fn(async (): Promise<SyncResult> => ({ status: "synced", success: 1, failed: 0, errors: [] }));
});

describe("runEntitlementReconciliation", () => {
  it("leaves freshly synced users alone", async () => {
    const owner = user("user-1");
    harness.store = new MemoryStore([
      ["users", owner.id, owner], ["inbounds", inbound.id, inbound],
      ["inbound-node-bindings", "inbound-1:node-1", binding("node-1")],
      ["clients", `${owner.id}:${inbound.id}`, mapping(owner.id, { updatedAt: new Date().toISOString() })],
    ]);

    expect(await runEntitlementReconciliation(env)).toMatchObject({ scanned: 1, due: 0, synced: 0, failed: 0 });
    expect(harness.sync).not.toHaveBeenCalled();
  });

  it("re-syncs a WireGuard mapping that has no peer credentials yet", async () => {
    const owner = user("user-1");
    const wireguard = { ...inbound, protocol: "wireguard" } as Inbound;
    harness.store = new MemoryStore([
      ["users", owner.id, owner], ["inbounds", wireguard.id, wireguard],
      ["inbound-node-bindings", "inbound-1:node-1", binding("node-1")],
      ["clients", `${owner.id}:${inbound.id}`, mapping(owner.id, { updatedAt: new Date().toISOString() })],
    ]);

    expect(await runEntitlementReconciliation(env)).toMatchObject({ scanned: 1, due: 1, synced: 1 });
    expect(harness.sync).toHaveBeenCalledTimes(1);

    // Once the peer exists, a freshly synced mapping is left alone again.
    harness.sync = vi.fn(async (): Promise<SyncResult> => ({ status: "synced", success: 1, failed: 0, errors: [] }));
    const store = new MemoryStore([
      ["users", owner.id, owner], ["inbounds", wireguard.id, wireguard],
      ["inbound-node-bindings", "inbound-1:node-1", binding("node-1")],
      ["clients", `${owner.id}:${inbound.id}`, mapping(owner.id, { updatedAt: new Date().toISOString(), wgPublicKey: "peer-key" })],
    ]);
    harness.store = store;

    expect(await runEntitlementReconciliation(env)).toMatchObject({ due: 0 });
    expect(harness.sync).not.toHaveBeenCalled();
  });

  it("repairs a missing mapping, a partial mapping and an expired plan", async () => {
    const fresh = user("user-fresh");
    const missing = user("user-missing");
    const partial = user("user-partial");
    const expired = user("user-expired", { planExpiresAt: "2025-12-31T00:00:00.000Z" });
    harness.store = new MemoryStore([
      ["users", fresh.id, fresh], ["users", missing.id, missing], ["users", partial.id, partial], ["users", expired.id, expired],
      ["inbounds", inbound.id, inbound],
      ["inbound-node-bindings", "inbound-1:node-1", binding("node-1")],
      ["inbound-node-bindings", "inbound-1:node-2", binding("node-2")],
      ["clients", `${fresh.id}:${inbound.id}`, mapping(fresh.id, { syncedNodes: ["node-1", "node-2"], updatedAt: new Date().toISOString() })],
      ["clients", `${partial.id}:${inbound.id}`, mapping(partial.id, { syncStatus: "partial", syncedNodes: ["node-1"], updatedAt: new Date().toISOString() })],
      ["clients", `${expired.id}:${inbound.id}`, mapping(expired.id, { syncedNodes: ["node-1", "node-2"], updatedAt: new Date().toISOString() })],
    ]);

    const result = await runEntitlementReconciliation(env);
    expect(result).toMatchObject({ scanned: 4, due: 3, synced: 3, failed: 0 });
    const synced = (harness.sync as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[2]);
    expect(synced.sort()).toEqual([expired.id, missing.id, partial.id].sort());
  });

  it("keeps staff accounts in step once they own panel clients", async () => {
    const admin = user("admin-1", { role: "admin" });
    const idleAdmin = user("admin-2", { role: "admin" });
    harness.store = new MemoryStore([
      ["users", admin.id, admin], ["users", idleAdmin.id, idleAdmin],
      ["inbounds", inbound.id, inbound],
      ["inbound-node-bindings", "inbound-1:node-1", binding("node-1")],
      // Stale mapping: the admin's client row is due for the periodic quota refresh.
      ["clients", `${admin.id}:${inbound.id}`, mapping(admin.id, { updatedAt: now })],
    ]);

    expect(await runEntitlementReconciliation(env)).toMatchObject({ scanned: 2, due: 1, synced: 1 });
    expect((harness.sync as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[2])).toEqual([admin.id]);
  });

  it("retires mappings that no longer belong to the user's plan", async () => {
    const owner = user("user-1", { planId: "plan-b" });
    harness.store = new MemoryStore([
      ["users", owner.id, owner], ["inbounds", inbound.id, { ...inbound, planIds: ["plan-a"] }],
      ["inbound-node-bindings", "inbound-1:node-1", binding("node-1")],
      ["clients", `${owner.id}:${inbound.id}`, mapping(owner.id, { updatedAt: new Date().toISOString() })],
    ]);

    expect(await runEntitlementReconciliation(env)).toMatchObject({ due: 1, synced: 1 });
    expect(harness.sync).toHaveBeenCalledTimes(1);
  });

  it("ignores inbounds that have no provisioned panel inbound", async () => {
    const idle = user("user-idle");
    harness.store = new MemoryStore([
      ["users", idle.id, idle],
      ["inbounds", inbound.id, inbound],
      ["inbound-node-bindings", "inbound-1:node-1", binding("node-1", 0)],
    ]);

    expect(await runEntitlementReconciliation(env)).toMatchObject({ scanned: 1, due: 0, synced: 0 });
    expect(harness.sync).not.toHaveBeenCalled();
  });

  it("caps each run at ten users", async () => {
    const seed: Array<[string, string, unknown]> = [
      ["inbounds", inbound.id, inbound],
      ["inbound-node-bindings", "inbound-1:node-1", binding("node-1")],
    ];
    for (let index = 0; index < 12; index += 1) {
      seed.push(["users", `user-${index}`, user(`user-${index}`)]);
    }
    harness.store = new MemoryStore(seed);

    const result = await runEntitlementReconciliation(env);
    expect(result).toMatchObject({ scanned: 12, due: 12, synced: 10, failed: 0 });
    expect(harness.sync).toHaveBeenCalledTimes(10);
  });

  it("counts failed synchronisations without aborting the batch", async () => {
    const owner = user("user-1");
    harness.store = new MemoryStore([["users", owner.id, owner], ["inbounds", inbound.id, inbound], ["inbound-node-bindings", "inbound-1:node-1", binding("node-1")]]);
    harness.sync = vi.fn(async () => { throw new Error("panel offline"); });

    expect(await runEntitlementReconciliation(env)).toMatchObject({ due: 1, synced: 0, failed: 1 });
  });
});
