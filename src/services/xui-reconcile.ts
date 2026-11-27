import type { RuntimeEnv } from "../env";
import { servesPlan } from "../domain/defaults";
import type { ClientMapping, Inbound, InboundNodeBinding, User } from "../domain/types";
import { getStore } from "../storage";
import type { DocumentStore, Page } from "../storage/store";
import { syncUserEntitlements } from "./xui-sync";

const LEASE = "entitlement-reconcile";
const LEASE_MS = 55_000;
const USERS_PER_RUN = 10;
const FULL_SWEEP_MS = 6 * 60 * 60 * 1000;

async function listAll<T>(store: DocumentStore, collection: string, prefix?: string): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<T> = await store.list<T>(collection, { limit: 100, cursor, prefix });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return items;
}

export interface ReconcileResult {
  scanned: number;
  due: number;
  synced: number;
  failed: number;
}

type DueUser = { user: User; priority: number; updatedAt: number };

/**
 * Re-runs entitlement synchronisation for accounts whose clients drifted from their plan:
 * missing or unsynced mappings, fewer synced nodes than bindings, expired plans, exhausted
 * quota, or mappings that no longer belong to the current plan. Runs under a lease so the
 * one-minute cron cannot overlap, and only takes a bounded batch per tick.
 */
export async function runEntitlementReconciliation(env: RuntimeEnv): Promise<ReconcileResult> {
  const empty: ReconcileResult = { scanned: 0, due: 0, synced: 0, failed: 0 };
  const store = getStore(env);
  const owner = crypto.randomUUID();
  if (!(await store.acquireLease(LEASE, owner, Date.now() + LEASE_MS))) return empty;
  try {
    const [users, inbounds, bindings, mappings] = await Promise.all([
      listAll<User>(store, "users"),
      listAll<Inbound>(store, "inbounds"),
      listAll<InboundNodeBinding>(store, "inbound-node-bindings"),
      listAll<ClientMapping>(store, "clients"),
    ]);
    const now = Date.now();
    const bindingsByInbound = new Map<string, InboundNodeBinding[]>();
    for (const binding of bindings) {
      const list = bindingsByInbound.get(binding.inboundId) ?? [];
      list.push(binding);
      bindingsByInbound.set(binding.inboundId, list);
    }
    const mappingsByUser = new Map<string, ClientMapping[]>();
    for (const mapping of mappings) {
      const list = mappingsByUser.get(mapping.userId) ?? [];
      list.push(mapping);
      mappingsByUser.set(mapping.userId, list);
    }

    const due: DueUser[] = [];
    for (const user of users) {
      if (!user.enabled) continue;
      const owned = mappingsByUser.get(user.id) ?? [];
      // Staff accounts are kept in step once they already own panel clients; a brand-new admin is
      // still provisioned on sign-in, so cron never creates clients for accounts nobody signed into.
      if (user.role !== "user" && owned.length === 0) continue;
      const eligible = inbounds.filter((inbound) => servesPlan(inbound, user));
      const expired = Boolean(user.planExpiresAt && Date.parse(user.planExpiresAt) <= now);
      const exhausted = user.planTrafficBytes > 0 && user.billedBytes >= user.planTrafficBytes;
      let priority = 0;
      let needsSync = false;
      for (const inbound of eligible) {
        // An inbound without a provisioned panel inbound cannot hold a client, so its mapping stays
        // `pending` forever; retrying it every tick would starve the batch.
        const expected = (bindingsByInbound.get(inbound.id) ?? []).filter((binding) => binding.panelInboundId > 0).length;
        if (!expected) continue;
        const mapping = owned.find((item) => item.inboundId === inbound.id);
        if (!mapping) { needsSync = true; priority = Math.max(priority, 2); break; }
        if (mapping.syncStatus !== "synced") { needsSync = true; priority = Math.max(priority, 3); break; }
        if (mapping.syncedNodes.length < expected) { needsSync = true; priority = Math.max(priority, 2); break; }
        // A WireGuard mapping only becomes usable once its peer credentials exist; inbound enabled
        // after the last sync (or migrated from an older build) still needs one more pass.
        if (inbound.protocol.toLowerCase() === "wireguard" && !mapping.wgPublicKey) { needsSync = true; priority = Math.max(priority, 3); break; }
        if (now - Date.parse(mapping.updatedAt || mapping.createdAt) > FULL_SWEEP_MS) { needsSync = true; priority = Math.max(priority, 1); break; }
      }
      if (!needsSync && owned.some((mapping) => mapping.enable && !eligible.some((inbound) => inbound.id === mapping.inboundId))) {
        needsSync = true;
        priority = Math.max(priority, 2);
      }
      if (!needsSync && (expired || exhausted) && owned.some((mapping) => mapping.enable)) {
        needsSync = true;
        priority = Math.max(priority, 3);
      }
      if (!needsSync) continue;
      const updatedAt = owned.length ? Math.min(...owned.map((mapping) => Date.parse(mapping.updatedAt || mapping.createdAt) || 0)) : 0;
      due.push({ user, priority, updatedAt });
    }

    due.sort((a, b) => b.priority - a.priority || a.updatedAt - b.updatedAt);
    const batch = due.slice(0, USERS_PER_RUN);
    let synced = 0;
    let failed = 0;
    for (const entry of batch) {
      try {
        const result = await syncUserEntitlements(store, env, entry.user.id);
        if (result.status === "failed") failed += 1; else synced += 1;
      } catch {
        failed += 1;
      }
    }
    return { scanned: users.length, due: due.length, synced, failed };
  } finally {
    await store.releaseLease(LEASE, owner);
  }
}
