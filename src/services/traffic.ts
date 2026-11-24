import type { RuntimeEnv } from "../env";
import type { ClientMapping, Inbound, InboundNodeBinding, NodeRecord, User, UsageEvent } from "../domain/types";
import { readSetting, writeSetting } from "../domain/defaults";
import { ThreeXuiClient, type XuiInbound } from "../adapters/xui/client";
import { D1Store, type TrafficSampleInput } from "../storage/d1";
import type { DocumentStore, Page } from "../storage/store";
import { syncUserEntitlements } from "./xui-sync";

const JOB_NAME = "traffic-collector";
const LEASE_MS = 4 * 60 * 1000;
const NODES_PER_RUN = 8;
const NODE_CONCURRENCY = 4;
const REPAIRS_PER_RUN = 10;

async function listAll<T>(store: DocumentStore, collection: string): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<T> = await store.list<T>(collection, { limit: 100, cursor });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return items;
}

/**
 * Emails the panel lists inside an inbound's settings, or null when the payload carries no client
 * array at all. A configured client that is absent from this list no longer exists on the node.
 */
function panelClientEmails(inbound: XuiInbound | undefined): Set<string> | null {
  if (!inbound) return null;
  let settings = inbound.settings;
  if (typeof settings === "string") {
    try { settings = JSON.parse(settings); } catch { return null; }
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const clients = (settings as { clients?: unknown }).clients;
  if (!Array.isArray(clients)) return null;
  const emails = new Set<string>();
  for (const client of clients) {
    if (!client || typeof client !== "object") continue;
    const email = (client as { email?: unknown }).email;
    if (typeof email === "string" && email) emails.add(email);
  }
  return emails;
}

async function sampleNode(
  store: D1Store,
  env: RuntimeEnv,
  node: NodeRecord,
  bindings: InboundNodeBinding[],
  inboundById: Map<string, Inbound>,
  mappingsByInbound: Map<string, ClientMapping[]>,
): Promise<{ samples: number; failures: number; missing: ClientMapping[] }> {
  let samples = 0;
  let failures = 0;
  const missing = new Map<string, ClientMapping>();
  try {
    const client = await ThreeXuiClient.connect(env, node);
    const panelInbounds = await client.listInbounds();
    for (const binding of bindings) {
      const inbound = inboundById.get(binding.inboundId);
      if (!inbound) continue;
      try {
        const usageByEmail = client.readClientUsage(panelInbounds, binding.panelInboundId);
        const configured = inbound.protocol.toLowerCase() === "wireguard" ? null : panelClientEmails(panelInbounds.find((item) => item.id === binding.panelInboundId));
        const occurredAt = new Date().toISOString();
        const usageDay = occurredAt.slice(0, 10);
        const inputs: TrafficSampleInput[] = [];
        for (const mapping of mappingsByInbound.get(inbound.id) ?? []) {
          // A deleted or recreated inbound silently loses its clients; note them so the run can
          // re-provision the account instead of waiting for the six-hour sweep.
          if (configured !== null && mapping.enable && !configured.has(mapping.email)) missing.set(mapping.id, mapping);
          const totalBytes = usageByEmail.get(mapping.email);
          if (totalBytes === undefined) continue;
          const input: TrafficSampleInput = {
            userId: mapping.userId,
            nodeId: node.id,
            inboundId: inbound.id,
            clientKey: mapping.clientId,
            totalBytes,
            multiplier: inbound.multiplier,
            occurredAt,
            usageDay,
          };
          inputs.push(input);
        }
        await store.recordTrafficSamples(inputs);
        samples += inputs.length;
      } catch (error) {
        failures += 1;
        console.error(JSON.stringify({ event: "traffic_inbound_sample_failed", nodeId: node.id, inboundId: inbound.id, message: error instanceof Error ? error.message : "unknown" }));
      }
    }
  } catch (error) {
    failures += 1;
    console.error(JSON.stringify({ event: "traffic_node_sample_failed", nodeId: node.id, message: error instanceof Error ? error.message : "unknown" }));
  }
  return { samples, failures, missing: [...missing.values()] };
}

async function applyUsageAndEnforce(store: D1Store, env: RuntimeEnv, users: User[], mappings: ClientMapping[]): Promise<{ appliedEvents: number; disabledUsers: number; unappliedEvents: number }> {
  let applied: UsageEvent[] = [];
  let unappliedEvents = 0;
  for (let page = 0; page < 4; page += 1) {
    const result = await store.applyPendingUsageEvents(250);
    applied.push(...result.events);
    unappliedEvents = result.unapplied;
    if (result.events.length === 0 || unappliedEvents === 0) break;
  }
  const touchedUserIds = new Set(applied.map((event) => event.userId));
  const usersById = new Map(users.map((user) => [user.id, user]));
  const mappingsByUser = new Map<string, ClientMapping[]>();
  for (const mapping of mappings) {
    const list = mappingsByUser.get(mapping.userId) ?? [];
    list.push(mapping);
    mappingsByUser.set(mapping.userId, list);
  }
  const candidates = new Set<string>();
  for (const id of touchedUserIds) candidates.add(id);
  for (const user of users) {
    const needsDisableRetry = (mappingsByUser.get(user.id) ?? []).some((mapping) => mapping.enable || (mapping.syncedNodes.length > 0 && mapping.syncStatus !== "synced"));
    if (needsDisableRetry && (!user.enabled || (user.planExpiresAt !== null && Date.parse(user.planExpiresAt) <= Date.now()) || user.billedBytes >= user.planTrafficBytes)) candidates.add(user.id);
  }
  let disabledUsers = 0;
  for (const userId of candidates) {
    const user = (await store.get<User>("users", userId)) ?? usersById.get(userId);
    if (!user) continue;
    const needsDisableRetry = (mappingsByUser.get(userId) ?? []).some((mapping) => mapping.enable || (mapping.syncedNodes.length > 0 && mapping.syncStatus !== "synced"));
    const exhausted = user.billedBytes >= user.planTrafficBytes;
    const expired = user.planExpiresAt !== null && Date.parse(user.planExpiresAt) <= Date.now();
    if (!needsDisableRetry || (user.enabled && !exhausted && !expired)) continue;
    const result = await syncUserEntitlements(store, env, userId);
    if (result.status !== "synced") console.error(JSON.stringify({ event: "traffic_quota_disable_partial", userId, status: result.status, failedNodes: result.failed }));
    else disabledUsers += 1;
  }
  return { appliedEvents: applied.length, disabledUsers, unappliedEvents };
}

/**
 * Re-issues the panel clients for accounts whose client row disappeared from an inbound. Runs under
 * the traffic lease and only for accounts that should still be served, so a deleted inbound or a
 * wiped client list repairs itself on the next sample instead of waiting for the periodic sweep.
 */
async function repairMissingClients(store: D1Store, env: RuntimeEnv, missing: ClientMapping[], users: User[]): Promise<{ repaired: number; failed: number }> {
  if (!missing.length) return { repaired: 0, failed: 0 };
  const usersById = new Map(users.map((user) => [user.id, user]));
  const candidates = new Set<string>();
  for (const mapping of missing) {
    const user = usersById.get(mapping.userId);
    if (!user || !user.enabled) continue;
    if (user.planTrafficBytes > 0 && user.billedBytes >= user.planTrafficBytes) continue;
    if (user.planExpiresAt && Date.parse(user.planExpiresAt) <= Date.now()) continue;
    candidates.add(user.id);
  }
  let repaired = 0;
  let failed = 0;
  for (const userId of [...candidates].slice(0, REPAIRS_PER_RUN)) {
    try {
      const result = await syncUserEntitlements(store, env, userId);
      if (result.status === "synced") repaired += 1; else failed += 1;
    } catch (error) {
      failed += 1;
      console.error(JSON.stringify({ event: "traffic_client_repair_failed", userId, message: error instanceof Error ? error.message : "unknown" }));
    }
  }
  return { repaired, failed };
}

export async function runTrafficCollection(env: RuntimeEnv): Promise<void> {
  if ((env.STORAGE_DRIVER ?? "d1").toLowerCase() !== "d1" || !env.DB) {
    console.info(JSON.stringify({ event: "traffic_metering_unavailable", reason: "D1 is required for atomic traffic accounting and quota enforcement." }));
    return;
  }
  const store = new D1Store(env.DB);
  const owner = crypto.randomUUID();
  if (!(await store.acquireLease(JOB_NAME, owner, Date.now() + LEASE_MS))) return;
  try {
    const [nodes, inbounds, bindings, mappings, users] = await Promise.all([
      listAll<NodeRecord>(store, "nodes"),
      listAll<Inbound>(store, "inbounds"),
      listAll<InboundNodeBinding>(store, "inbound-node-bindings"),
      listAll<ClientMapping>(store, "clients"),
      listAll<User>(store, "users"),
    ]);
    const sampleNodes = nodes.filter((node) => node.enabled && bindings.some((binding) => binding.nodeId === node.id)).sort((a, b) => a.id.localeCompare(b.id));
    const cursorValue = await readSetting<unknown>(store, "trafficSampleCursor", 0);
    const cursor = typeof cursorValue === "number" && Number.isInteger(cursorValue) && cursorValue >= 0 ? cursorValue % Math.max(sampleNodes.length, 1) : 0;
    const selectedCount = Math.min(NODES_PER_RUN, sampleNodes.length);
    const selectedNodes = Array.from({ length: selectedCount }, (_, offset) => sampleNodes[(cursor + offset) % sampleNodes.length]!);
    const nextCursor = (cursor + selectedCount) % Math.max(sampleNodes.length, 1);
    await writeSetting(store, "trafficSampleCursor", nextCursor);
    const inboundById = new Map(inbounds.map((inbound) => [inbound.id, inbound]));
    const mappingsByInbound = new Map<string, ClientMapping[]>();
    for (const mapping of mappings) {
      const list = mappingsByInbound.get(mapping.inboundId) ?? [];
      list.push(mapping);
      mappingsByInbound.set(mapping.inboundId, list);
    }
    let samples = 0;
    let failures = 0;
    const missing = new Map<string, ClientMapping>();
    for (let offset = 0; offset < selectedNodes.length; offset += NODE_CONCURRENCY) {
      const batch = selectedNodes.slice(offset, offset + NODE_CONCURRENCY);
      const results = await Promise.all(batch.map((node) => sampleNode(store, env, node, bindings.filter((binding) => binding.nodeId === node.id), inboundById, mappingsByInbound)));
      samples += results.reduce((sum, result) => sum + result.samples, 0);
      failures += results.reduce((sum, result) => sum + result.failures, 0);
      for (const result of results) for (const mapping of result.missing) missing.set(mapping.id, mapping);
    }
    const repairs = await repairMissingClients(store, env, [...missing.values()], users);
    const enforcement = await applyUsageAndEnforce(store, env, users, mappings);
    console.info(JSON.stringify({ event: "traffic_collection_complete", nodes: selectedNodes.length, samples, failures, missingClients: missing.size, ...repairs, ...enforcement }));
  } finally {
    await store.releaseLease(JOB_NAME, owner);
  }
}
