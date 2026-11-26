import { describe, expect, it, vi } from "vitest";
import { ThreeXuiClient } from "../adapters/xui/client";
import type { ClientMapping, Inbound, InboundNodeBinding, NodeRecord, User } from "../domain/types";
import type { DocumentStore, ListOptions, Page } from "../storage/store";
import { syncNode } from "./xui-node-sync";

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
    const items = [...(this.records.get(collection) ?? new Map()).entries()]
      .filter(([id]) => id > (options.cursor ?? "") && (!options.prefix || id.startsWith(options.prefix)))
      .sort(([left], [right]) => left.localeCompare(right));
    const page = items.slice(0, limit);
    return {
      items: page.map(([, value]) => structuredClone(value) as T),
      cursor: items.length > limit ? page.at(-1)?.[0] ?? null : null,
    };
  }

  async has(collection: string, id: string): Promise<boolean> {
    return this.records.get(collection)?.has(id) ?? false;
  }

  async acquireLease(): Promise<boolean> {
    return true;
  }

  async releaseLease(): Promise<void> {}
}

const user: User = {
  id: "user-1", email: "user@example.test", passwordHash: "", emailVerifiedAt: null, role: "user", balanceMinor: 0,
  planId: "plan-1", planLevel: 1, planExpiresAt: null, planTrafficBytes: 1000, billedBytes: 0,
  planStartedAt: "2026-01-01T00:00:00.000Z", trafficResetAt: null, enabled: true, inviteCode: null,
  invitedBy: null, inviteCount: 0, checkinStreak: 0, lastCheckinAt: null, lastActiveAt: null,
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};

const inbound: Inbound = {
  id: "inbound-1", name: "test", protocol: "vless", port: 443, network: "tcp", minimumLevel: 0,
  multiplier: 1, enabled: true, config: {},
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};

const mapping: ClientMapping = {
  id: "user-1:inbound-1", userId: user.id, inboundId: inbound.id, email: "u_user-1_inbound-1",
  clientId: "11111111-1111-4111-8111-111111111111", encryptedSecret: null, flow: "", enable: true,
  syncStatus: "synced", syncError: null, syncedNodes: [inbound.id], createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const binding: InboundNodeBinding = {
  id: `${inbound.id}:node-1`, inboundId: inbound.id, nodeId: "node-1", panelInboundId: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const node = {
  id: "node-1", name: "test node", region: "", panelUrl: "https://panel.example.test", publicAddress: "",
  username: "", encryptedPassword: "", apiTokenEncrypted: null, basePath: "/", status: "online",
  supportedApi: true, lastCheckedAt: null, inboundCount: 1, syncStatus: "synced", lastSyncAt: null,
  lastError: null, enabled: true, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
} as NodeRecord;

function seed() {
  return new MemoryStore([
    ["users", user.id, user],
    ["inbounds", inbound.id, inbound],
    ["clients", mapping.id, mapping],
    ["inbound-node-bindings", binding.id, binding],
    ["nodes", node.id, node],
  ]);
}

function fakePanel(panelId: string) {
  const upsertClient = vi.fn(async () => undefined);
  const fake = {
    listInbounds: vi.fn(async () => [{
      id: 1, protocol: "vless", settings: JSON.stringify({
        clients: [{ email: mapping.email, id: panelId, totalGB: 1000, expiryTime: 0, enable: true, limitIp: 0, flow: "" }],
      }), streamSettings: "{}", sniffing: "{}",
      clientStats: [{ email: mapping.email, up: 0, down: 0 }],
    }]),
    readClientUsage: ThreeXuiClient.prototype.readClientUsage,
    upsertClient,
  } as unknown as ThreeXuiClient;
  return { upsertClient, connect: vi.spyOn(ThreeXuiClient, "connect").mockResolvedValue(fake) };
}

describe("syncNode client identity", () => {
  it("rewrites a panel client whose UUID drifted from the account", async () => {
    const store = seed();
    const { upsertClient, connect } = fakePanel("22222222-2222-4222-8222-222222222222");
    const result = await syncNode(store, {} as never, node).finally(() => connect.mockRestore());

    expect(result.written).toBe(1);
    expect(result.unchanged).toBe(0);
    expect(upsertClient).toHaveBeenCalledTimes(1);
    expect(await store.get<ClientMapping>("clients", mapping.id)).toMatchObject({
      syncedNodes: ["node-1"], syncStatus: "synced",
    });
  });

  it("leaves a client alone when the panel UUID matches the account", async () => {
    const store = seed();
    const { upsertClient, connect } = fakePanel(mapping.clientId);
    const result = await syncNode(store, {} as never, node).finally(() => connect.mockRestore());

    expect(result.written).toBe(0);
    expect(result.unchanged).toBe(1);
    expect(upsertClient).not.toHaveBeenCalled();
  });
});
