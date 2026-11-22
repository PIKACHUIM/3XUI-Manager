import { describe, expect, it, vi } from "vitest";
import { ThreeXuiClient } from "../adapters/xui/client";
import type { ClientMapping, Inbound, InboundNodeBinding, NodeRecord, User } from "../domain/types";
import type { DocumentStore, ListOptions, Page } from "../storage/store";
import { syncClientToNodes } from "./xui-sync";

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
  id: "user-1:inbound-1", userId: user.id, inboundId: inbound.id, email: "test-client", clientId: "client-1",
  encryptedSecret: null, flow: "", enable: true, syncStatus: "synced", syncError: null,
  syncedNodes: ["node-1"], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
};

const binding: InboundNodeBinding = { id: "inbound-1:node-1", inboundId: inbound.id, nodeId: "node-1", panelInboundId: 1, createdAt: "2026-01-01T00:00:00.000Z" };
const node = { id: "node-1", enabled: false } as NodeRecord;

describe("syncClientToNodes", () => {
  it("keeps disabled previously synced nodes in the retry set", async () => {
    const store = new MemoryStore([
      ["users", user.id, user], ["inbounds", inbound.id, inbound], ["clients", mapping.id, mapping],
      ["inbound-node-bindings", binding.id, binding], ["nodes", node.id, node],
    ]);

    await syncClientToNodes(store, {} as never, mapping);

    expect(await store.get<ClientMapping>("clients", mapping.id)).toMatchObject({
      syncedNodes: ["node-1"],
      syncStatus: "failed",
      syncError: "node-1: Node is disabled; synchronization is deferred.",
    });
  });

  it("keeps previously synced nodes when panel synchronization fails", async () => {
    const enabledNode = { ...node, enabled: true } as NodeRecord;
    const store = new MemoryStore([
      ["users", user.id, user], ["inbounds", inbound.id, inbound], ["clients", mapping.id, mapping],
      ["inbound-node-bindings", binding.id, binding], ["nodes", enabledNode.id, enabledNode],
    ]);
    const connect = vi.spyOn(ThreeXuiClient, "connect").mockRejectedValue(new Error("panel offline"));

    try {
      await syncClientToNodes(store, {} as never, mapping);
    } finally {
      connect.mockRestore();
    }

    expect(await store.get<ClientMapping>("clients", mapping.id)).toMatchObject({
      syncedNodes: ["node-1"],
      syncStatus: "failed",
      syncError: "node-1: panel offline",
    });
  });
});

describe("syncClientToNodes with WireGuard", () => {
  const wgInbound: Inbound = {
    ...inbound, id: "inbound-wg", name: "wg", protocol: "wireguard", port: 51820, network: "udp",
    config: { settings: { secretKey: "server-secret", address: [], subnetIp: "10.0.0.0", subnetCidr: 24, mtu: 1420, peers: [] } },
  };
  const wgBinding: InboundNodeBinding = { ...binding, id: "inbound-wg:node-1", inboundId: wgInbound.id, panelInboundId: 7 };
  const wgMapping: ClientMapping = {
    ...mapping, id: `user-1:${wgInbound.id}`, inboundId: wgInbound.id,
    wgPrivateKey: "dwdtCnMYpX08FsFyUbJmRd9ML4frwJkqsXf7pR25LCo=",
    wgPublicKey: "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo=",
  };
  const wgNode = { ...node, enabled: true } as NodeRecord;

  function fakePanel(settings: Record<string, unknown>) {
    const updates: Array<{ id: number; body: Inbound }> = [];
    const fake = {
      listInbounds: vi.fn(async () => [{ id: 7, protocol: "wireguard", settings: JSON.stringify(settings), streamSettings: {}, sniffing: {} }]),
      updateInbound: vi.fn(async (id: number, body: Inbound) => { updates.push({ id, body }); }),
    } as unknown as ThreeXuiClient;
    return { updates, connect: vi.spyOn(ThreeXuiClient, "connect").mockResolvedValue(fake) };
  }

  it("adds one peer with a /32 address and keeps the panel settings intact", async () => {
    const store = new MemoryStore([
      ["users", user.id, user], ["inbounds", wgInbound.id, wgInbound], ["clients", wgMapping.id, wgMapping],
      ["inbound-node-bindings", wgBinding.id, wgBinding], ["nodes", wgNode.id, wgNode],
    ]);
    const { updates, connect } = fakePanel({ secretKey: "server-secret", address: ["10.0.0.1/24"], subnetIp: "10.0.0.0", subnetCidr: 24, mtu: 1420, peers: [] });
    try {
      await syncClientToNodes(store, {} as never, wgMapping);
    } finally {
      connect.mockRestore();
    }
    expect(updates).toHaveLength(1);
    expect(updates[0]?.id).toBe(7);
    const settings = updates[0]?.body.config.settings as Record<string, unknown>;
    expect(settings).toMatchObject({ secretKey: "server-secret", address: ["10.0.0.1/24"], subnetIp: "10.0.0.0", mtu: 1420 });
    expect(settings.peers).toEqual([{ publicKey: wgMapping.wgPublicKey, allowedIPs: ["10.0.0.2/32"], keepAlive: 0 }]);
    expect(await store.get<ClientMapping>("clients", wgMapping.id)).toMatchObject({
      syncStatus: "synced", syncedNodes: ["node-1"], wgAddresses: { "node-1": "10.0.0.2" },
    });
  });

  it("removes the peer when the account is no longer eligible", async () => {
    const expired = { ...user, planTrafficBytes: 10, billedBytes: 10 };
    const store = new MemoryStore([
      ["users", user.id, expired], ["inbounds", wgInbound.id, wgInbound], ["clients", wgMapping.id, wgMapping],
      ["inbound-node-bindings", wgBinding.id, wgBinding], ["nodes", wgNode.id, wgNode],
    ]);
    const { updates, connect } = fakePanel({ secretKey: "server-secret", subnetIp: "10.0.0.0", subnetCidr: 24, mtu: 1420, peers: [{ publicKey: wgMapping.wgPublicKey, allowedIPs: ["10.0.0.9/32"], keepAlive: 0 }] });
    try {
      await syncClientToNodes(store, {} as never, wgMapping);
    } finally {
      connect.mockRestore();
    }
    expect(updates).toHaveLength(1);
    expect((updates[0]?.body.config.settings as { peers: unknown[] }).peers).toEqual([]);
  });
});
