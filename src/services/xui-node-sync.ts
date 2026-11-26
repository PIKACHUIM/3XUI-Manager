import type { RuntimeEnv } from "../env";
import { readSetting, servesPlan, writeSetting } from "../domain/defaults";
import type { ClientMapping, Inbound, InboundNodeBinding, NodeRecord, User } from "../domain/types";
import type { DocumentStore } from "../storage/store";
import { D1Store } from "../storage/d1";
import { ThreeXuiClient, clientQuota, quotaMatches, readPanelClients, type XuiInbound } from "../adapters/xui/client";
import { listCollection } from "./xui-sync";
import { syncWireGuardPeer } from "./wireguard";

const JOB_NAME = "node-sync";
const LEASE_MS = 4 * 60 * 1000;
const NODES_PER_RUN = 6;
const NODE_CONCURRENCY = 2;
const CURSOR_SETTING = "nodeSyncCursor";
const ERROR_LIMIT = 500;

export interface NodeSyncResult {
  nodeId: string;
  online: boolean;
  clients: number;
  written: number;
  unchanged: number;
  disabled: number;
  failed: number;
  error: string | null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : "3X-UI synchronization failed.";
}

/** The client-side VLESS encryption of one panel inbound; empty when the panel does not expose it. */
function panelEncryption(inbounds: readonly XuiInbound[], panelInboundId: number): string | null {
  const inbound = inbounds.find((item) => item.id === panelInboundId);
  if (!inbound) return null;
  let settings = inbound.settings;
  if (typeof settings === "string") {
    try { settings = JSON.parse(settings); } catch { return null; }
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const encryption = (settings as { encryption?: unknown }).encryption;
  return typeof encryption === "string" && encryption.trim() ? encryption.trim() : null;
}

/**
 * Whether the account should hold an enabled client on this inbound right now. Mirrors
 * `syncUserEntitlements` so both paths agree on who is served.
 */
function eligibleFor(inbound: Inbound, user: User): boolean {
  if (!servesPlan(inbound, user) || !user.enabled) return false;
  if (user.planExpiresAt && Date.parse(user.planExpiresAt) <= Date.now()) return false;
  return user.planTrafficBytes > user.billedBytes;
}

/** A client that vanished from the panel is already off; treat "not found" as done. */
async function disableIfPresent(client: ThreeXuiClient, email: string): Promise<void> {
  try {
    await client.disableClientEmail(email);
  } catch (error) {
    if (!(error instanceof Error) || !/not found/i.test(error.message)) throw error;
  }
}

/**
 * One pass over a node: read its panel state once, then make every managed client match the
 * account — quota, expiry, enabled state and the Hysteria `auth` token — and drop the clients of
 * accounts this inbound no longer serves. The manager is the source of truth, so the panel is
 * written to match it; clients the manager does not own are left untouched.
 */
export async function syncNode(store: DocumentStore, env: RuntimeEnv, node: NodeRecord): Promise<NodeSyncResult> {
  const [inbounds, bindings, mappings, users] = await Promise.all([
    listCollection<Inbound>(store, "inbounds"),
    listCollection<InboundNodeBinding>(store, "inbound-node-bindings"),
    listCollection<ClientMapping>(store, "clients"),
    listCollection<User>(store, "users"),
  ]);
  const now = new Date().toISOString();
  const usersById = new Map(users.map((user) => [user.id, user]));
  const inboundById = new Map(inbounds.map((inbound) => [inbound.id, inbound]));
  const nodeBindings = bindings.filter((binding) => binding.nodeId === node.id && binding.panelInboundId > 0);
  const mappingsByInbound = new Map<string, ClientMapping[]>();
  for (const mapping of mappings) {
    const list = mappingsByInbound.get(mapping.inboundId) ?? [];
    list.push(mapping);
    mappingsByInbound.set(mapping.inboundId, list);
  }
  const markOffline = async (message: string): Promise<NodeSyncResult> => {
    node.status = "offline";
    node.lastCheckedAt = now;
    node.syncStatus = "failed";
    node.lastError = message.slice(0, ERROR_LIMIT);
    node.updatedAt = now;
    await store.put("nodes", node.id, node);
    return { nodeId: node.id, online: false, clients: 0, written: 0, unchanged: 0, disabled: 0, failed: 1, error: message };
  };

  let client: ThreeXuiClient;
  let panelInbounds: XuiInbound[];
  try {
    client = await ThreeXuiClient.connect(env, node);
    panelInbounds = await client.listInbounds();
  } catch (error) {
    return markOffline(describe(error));
  }
  node.status = "online";
  node.lastCheckedAt = now;
  node.inboundCount = panelInbounds.length;
  // A shared inbound can be created separately on each node, so its ML-KEM client encryption is
  // node-local. Keep the panel value on the binding so the subscription sends the matching one.
  for (const binding of nodeBindings) {
    const encryption = panelEncryption(panelInbounds, binding.panelInboundId);
    if (encryption && encryption !== binding.encryption) {
      binding.encryption = encryption;
      await store.put("inbound-node-bindings", binding.id, binding);
    }
  }

  let clients = 0;
  let written = 0;
  let unchanged = 0;
  let disabled = 0;
  let failed = 0;
  const errors: string[] = [];
  const mappingErrors = new Map<string, string>();
  const touched = new Set<string>();

  for (const binding of nodeBindings) {
    const inbound = inboundById.get(binding.inboundId);
    if (!inbound) continue;
    const managed = mappingsByInbound.get(inbound.id) ?? [];
    let usage: Map<string, number>;
    let panelClients: Map<string, Record<string, unknown>> | null;
    try {
      usage = client.readClientUsage(panelInbounds, binding.panelInboundId);
      panelClients = readPanelClients(panelInbounds, binding.panelInboundId);
    } catch (error) {
      failed += 1;
      errors.push(`${inbound.name}: ${describe(error)}`);
      continue;
    }
    const wireguard = inbound.protocol.toLowerCase() === "wireguard";
    for (const mapping of managed) {
      const user = usersById.get(mapping.userId);
      if (!user) continue;
      clients += 1;
      const eligible = eligibleFor(inbound, user);
      mapping.enable = eligible;
      const onPanel = panelClients ? panelClients.has(mapping.email) : mapping.syncedNodes.includes(node.id);
      try {
        if (wireguard) {
          const hadPeer = Boolean(mapping.wgPublicKey);
          await syncWireGuardPeer(store, client, mapping, inbound, node.id, binding.panelInboundId, eligible);
          if (!eligible && hadPeer) disabled += 1;
        } else if (!eligible) {
          if (onPanel) {
            await disableIfPresent(client, mapping.email);
            disabled += 1;
          }
        } else {
          const used = usage.get(mapping.email);
          const existing = panelClients?.get(mapping.email);
          if (existing && quotaMatches(existing, clientQuota(mapping, inbound, user, used))) {
            unchanged += 1;
          } else {
            await client.upsertClient(mapping, inbound, binding, user, used);
            written += 1;
          }
        }
        mapping.syncedNodes = [...new Set([...mapping.syncedNodes, node.id])];
      } catch (error) {
        failed += 1;
        const message = describe(error);
        mappingErrors.set(mapping.id, message);
        errors.push(`${inbound.name}/${mapping.email}: ${message}`);
      }
      mapping.updatedAt = now;
      touched.add(mapping.id);
    }
    // Panel clients the manager no longer owns (deleted account, re-created inbound) must not keep
    // working. Only the emails this manager mints are touched, and they are disabled, never deleted.
    if (panelClients) {
      const managedEmails = new Set(managed.map((mapping) => mapping.email));
      for (const [email, row] of panelClients) {
        if (!email.startsWith("u_") || managedEmails.has(email) || row.enable === false) continue;
        try {
          await disableIfPresent(client, email);
          disabled += 1;
        } catch (error) {
          failed += 1;
          errors.push(`${inbound.name}/${email}: ${describe(error)}`);
        }
      }
    }
  }

  for (const id of touched) {
    const mapping = mappings.find((item) => item.id === id);
    if (!mapping) continue;
    const bindingNodeIds = new Set(bindings.filter((binding) => binding.inboundId === mapping.inboundId && binding.panelInboundId > 0).map((binding) => binding.nodeId));
    const synced = mapping.syncedNodes.filter((nodeId) => bindingNodeIds.has(nodeId));
    mapping.syncedNodes = synced;
    mapping.syncStatus = bindingNodeIds.size === 0 ? "pending" : synced.length >= bindingNodeIds.size ? "synced" : synced.length ? "partial" : "failed";
    mapping.syncError = mapping.syncStatus === "synced" ? null : mappingErrors.get(mapping.id) ?? null;
    await store.put("clients", mapping.id, mapping);
  }

  node.lastSyncAt = now;
  node.syncStatus = failed === 0 ? "synced" : written + unchanged + disabled > 0 ? "partial" : "failed";
  node.lastError = errors.length ? errors.slice(0, 5).join("; ").slice(0, ERROR_LIMIT) : null;
  node.updatedAt = now;
  await store.put("nodes", node.id, node);

  return { nodeId: node.id, online: true, clients, written, unchanged, disabled, failed, error: node.lastError };
}

/**
 * Cron entry point: reconciles every enabled node against the manager's accounts. Nodes are taken
 * in a rotating cursor so a large fleet still finishes every node within a few ticks, and the job
 * holds a lease so one-minute ticks cannot overlap.
 */
export async function runNodeSync(env: RuntimeEnv): Promise<{ nodes: number; written: number; unchanged: number; disabled: number; failed: number }> {
  const summary = { nodes: 0, written: 0, unchanged: 0, disabled: 0, failed: 0 };
  if ((env.STORAGE_DRIVER ?? "d1").toLowerCase() !== "d1" || !env.DB) return summary;
  const store = new D1Store(env.DB);
  const owner = crypto.randomUUID();
  if (!(await store.acquireLease(JOB_NAME, owner, Date.now() + LEASE_MS))) return summary;
  try {
    const nodes = (await listCollection<NodeRecord>(store, "nodes"))
      .filter((node) => node.enabled)
      .sort((left, right) => left.id.localeCompare(right.id));
    if (!nodes.length) return summary;
    const stored = await readSetting<unknown>(store, CURSOR_SETTING, 0);
    const cursor = typeof stored === "number" && Number.isInteger(stored) && stored >= 0 ? stored % nodes.length : 0;
    const count = Math.min(NODES_PER_RUN, nodes.length);
    const selected = Array.from({ length: count }, (_, offset) => nodes[(cursor + offset) % nodes.length]!);
    await writeSetting(store, CURSOR_SETTING, (cursor + count) % nodes.length);
    const results: NodeSyncResult[] = [];
    for (let offset = 0; offset < selected.length; offset += NODE_CONCURRENCY) {
      const batch = selected.slice(offset, offset + NODE_CONCURRENCY);
      results.push(...await Promise.all(batch.map((node) => syncNode(store, env, node).catch((error: unknown) => ({
        nodeId: node.id, online: false, clients: 0, written: 0, unchanged: 0, disabled: 0, failed: 1, error: describe(error),
      })))));
    }
    for (const result of results) {
      summary.nodes += 1;
      summary.written += result.written;
      summary.unchanged += result.unchanged;
      summary.disabled += result.disabled;
      summary.failed += result.failed;
    }
    console.info(JSON.stringify({ event: "node_sync_complete", ...summary }));
    return summary;
  } finally {
    await store.releaseLease(JOB_NAME, owner);
  }
}
