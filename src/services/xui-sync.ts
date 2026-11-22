import type { RuntimeEnv } from "../env";
import { randomToken, encryptSecret } from "../domain/security";
import { servesPlan } from "../domain/defaults";
import type { ClientMapping, Inbound, InboundNodeBinding, NodeRecord, User } from "../domain/types";
import type { DocumentStore, Page } from "../storage/store";
import { ThreeXuiClient } from "../adapters/xui/client";
import { syncWireGuardPeer } from "./wireguard";

async function listAll<T>(store: DocumentStore, collection: string, prefix?: string): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<T> = await store.list<T>(collection, { limit: 100, cursor, prefix });
    rows.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return rows;
}

export interface SyncResult {
  status: "synced" | "partial" | "failed";
  success: number;
  failed: number;
  errors: Array<{ nodeId: string; message: string }>;
}

export async function syncUserEntitlements(store: DocumentStore, env: RuntimeEnv, userId: string): Promise<SyncResult> {
  const user = await store.get<User>("users", userId);
  if (!user) throw new Error("User not found.");
  const [inbounds, mappings] = await Promise.all([
    listAll<Inbound>(store, "inbounds"),
    listAll<ClientMapping>(store, "clients", `${userId}:`),
  ]);
  const enabledInboundIds = new Set(inbounds.filter((inbound) => servesPlan(inbound, user)).map((inbound) => inbound.id));
  const byInbound = new Map(mappings.map((mapping) => [mapping.inboundId, mapping]));
  const now = new Date().toISOString();
  let success = 0;
  let failed = 0;
  const errors: SyncResult["errors"] = [];

  for (const inbound of inbounds) {
    const eligible = enabledInboundIds.has(inbound.id) && user.enabled && (!user.planExpiresAt || Date.parse(user.planExpiresAt) > Date.now()) && user.planTrafficBytes > user.billedBytes;
    let mapping = byInbound.get(inbound.id);
    if (!mapping && enabledInboundIds.has(inbound.id) && user.planTrafficBytes > user.billedBytes) {
      const encryptedSecret = inbound.protocol.toLowerCase() === "trojan" && env.APP_ENCRYPTION_KEY
        ? await encryptSecret(randomToken(24), env.APP_ENCRYPTION_KEY)
        : null;
      mapping = {
        id: `${user.id}:${inbound.id}`,
        userId: user.id,
        inboundId: inbound.id,
        email: `u_${user.id}_${inbound.id}`,
        clientId: crypto.randomUUID(),
        encryptedSecret,
        flow: inbound.protocol.toLowerCase() === "vless" ? inbound.defaultFlow ?? "" : "",
        enable: eligible,
        syncStatus: "pending",
        syncError: null,
        syncedNodes: [],
        createdAt: now,
        updatedAt: now,
      };
      await store.put("clients", mapping.id, mapping);
    }
    if (!mapping) continue;
    mapping.enable = eligible;
    mapping.updatedAt = now;
    const bindings = await listAll<InboundNodeBinding>(store, "inbound-node-bindings", `${inbound.id}:`);
    const nodeResults: string[] = [];
    const previouslySyncedNodes = new Set(mapping.syncedNodes ?? []);
    const bindingNodeIds = new Set(eligible ? bindings.map((binding) => binding.nodeId) : previouslySyncedNodes);
    let inboundSuccess = 0;
    let inboundFailed = 0;
    const inboundErrors: SyncResult["errors"] = [];
    for (const nodeId of bindingNodeIds) {
      const node = await store.get<NodeRecord>("nodes", nodeId);
      const binding = bindings.find((item) => item.nodeId === nodeId);
      if (!node || !node.enabled) {
        const message = node ? "Node is disabled; synchronization is deferred." : "Node record is missing.";
        inboundFailed += 1;
        failed += 1;
        inboundErrors.push({ nodeId, message });
        errors.push({ nodeId, message });
        if (previouslySyncedNodes.has(nodeId)) nodeResults.push(nodeId);
        continue;
      }
      try {
        const client = await ThreeXuiClient.connect(env, node);
        if (inbound.protocol.toLowerCase() === "wireguard") {
          // WireGuard has no per-client records: the account owns one peer with its own key pair.
          if (binding) await syncWireGuardPeer(store, client, mapping, inbound, nodeId, binding.panelInboundId, eligible);
        } else if (!eligible) await client.disableClient(mapping);
        else if (binding) await client.upsertClient(mapping, inbound, binding, user);
        nodeResults.push(nodeId);
        inboundSuccess += 1;
        success += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : "3X-UI synchronization failed.";
        inboundFailed += 1;
        failed += 1;
        inboundErrors.push({ nodeId, message });
        errors.push({ nodeId, message });
        if (previouslySyncedNodes.has(nodeId)) nodeResults.push(nodeId);
      }
    }
    mapping.syncedNodes = [...new Set(nodeResults)];
    mapping.syncStatus = bindingNodeIds.size === 0 ? "pending" : inboundFailed === 0 ? "synced" : inboundSuccess > 0 ? "partial" : "failed";
    mapping.syncError = inboundErrors.map((item) => `${item.nodeId}: ${item.message}`).join("; ").slice(0, 500) || null;
    mapping.updatedAt = now;
    await store.put("clients", mapping.id, mapping);
  }
  return { status: failed === 0 ? "synced" : success > 0 ? "partial" : "failed", success, failed, errors };
}

export async function syncClientToNodes(store: DocumentStore, env: RuntimeEnv, mapping: ClientMapping): Promise<SyncResult> {
  const inbound = await store.get<Inbound>("inbounds", mapping.inboundId);
  const user = await store.get<User>("users", mapping.userId);
  if (!inbound || !user) throw new Error("Client mapping has no matching user or inbound.");
  const bindings = await listAll<InboundNodeBinding>(store, "inbound-node-bindings", `${inbound.id}:`);
  let success = 0;
  let failed = 0;
  const errors: SyncResult["errors"] = [];
  const syncedNodes: string[] = [];
  const previouslySyncedNodes = new Set(mapping.syncedNodes ?? []);
  const hasTraffic = user.planTrafficBytes > user.billedBytes && (!user.planExpiresAt || Date.parse(user.planExpiresAt) > Date.now());
  for (const binding of bindings) {
    const node = await store.get<NodeRecord>("nodes", binding.nodeId);
    if (!node?.enabled) {
      failed += 1;
      errors.push({ nodeId: binding.nodeId, message: node ? "Node is disabled; synchronization is deferred." : "Node record is missing." });
      if (previouslySyncedNodes.has(binding.nodeId)) syncedNodes.push(binding.nodeId);
      continue;
    }
    try {
      const client = await ThreeXuiClient.connect(env, node);
      if (inbound.protocol.toLowerCase() === "wireguard") {
        await syncWireGuardPeer(store, client, mapping, inbound, binding.nodeId, binding.panelInboundId, mapping.enable && user.enabled && hasTraffic);
      } else if (!mapping.enable || !user.enabled || !hasTraffic) await client.disableClient(mapping);
      else await client.upsertClient(mapping, inbound, binding, user);
      syncedNodes.push(node.id);
      success += 1;
    } catch (error) {
      failed += 1;
      errors.push({ nodeId: binding.nodeId, message: error instanceof Error ? error.message : "Synchronization failed." });
      if (previouslySyncedNodes.has(binding.nodeId)) syncedNodes.push(binding.nodeId);
    }
  }
  mapping.syncedNodes = syncedNodes;
  mapping.syncStatus = failed === 0 && bindings.length > 0 ? "synced" : success > 0 ? "partial" : "failed";
  mapping.syncError = errors.map((item) => `${item.nodeId}: ${item.message}`).join("; ").slice(0, 500) || null;
  mapping.updatedAt = new Date().toISOString();
  await store.put("clients", mapping.id, mapping);
  return { status: mapping.syncStatus, success, failed, errors };
}

export async function listCollection<T>(store: DocumentStore, collection: string, prefix?: string): Promise<T[]> {
  return listAll<T>(store, collection, prefix);
}
