import { Hono } from "hono";
import { compareNodes, randomCheckinReward, readCheckinRewardRange, readSetting, servesPlan } from "../domain/defaults";
import type { ClientMapping, Inbound, InboundNodeBinding, NodeRecord, Order, Plan, User } from "../domain/types";
import { verifyTurnstile } from "../services/turnstile";
import { notificationRecordId, type UserNotification } from "../services/notifications";
import { syncUserEntitlements } from "../services/xui-sync";
import { D1Store } from "../storage/d1";
import { subscriptionCredential } from "../services/subscriptions";
import type { DocumentStore, Page } from "../storage/store";
import { requireUser, validateSameOrigin } from "./context";
import type { ApiEnv } from "./context";

interface DailyUsage {
  userId: string;
  usageDay: string;
  rawBytes: number;
  billedBytes: number;
  byNode?: Record<string, { rawBytes: number; billedBytes: number }>;
}

const userApi = new Hono<ApiEnv>();
userApi.use("*", async (c, next) => {
  if (c.req.method === "POST" && !validateSameOrigin(c.req.raw)) return c.json({ error: "Request origin is not allowed." }, 403);
  await next();
});
userApi.use("*", requireUser);

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

function publicUser(user: User): Omit<User, "passwordHash"> {
  const { passwordHash: _passwordHash, ...safe } = user;
  return safe;
}

function planIsActive(user: User): boolean {
  return user.enabled && (!user.planExpiresAt || Date.parse(user.planExpiresAt) > Date.now());
}

function dateInTimeZone(date: Date, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    // Invalid configured time zones fall back to UTC for stable check-in dates.
  }
  return date.toISOString().slice(0, 10);
}

function previousCalendarDay(day: string): string {
  const previous = new Date(`${day}T00:00:00.000Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return previous.toISOString().slice(0, 10);
}

userApi.post("/checkin", async (c) => {
  const store = c.get("store");
  if (!(store instanceof D1Store)) return c.json({ error: "Check-in requires D1 atomic storage." }, 503);
  const bodyValue: unknown = await c.req.json().catch(() => null);
  if (!bodyValue || typeof bodyValue !== "object" || Array.isArray(bodyValue)) return c.json({ error: "Invalid request body." }, 400);
  const body = bodyValue as Record<string, unknown>;
  const turnstileRequired = await readSetting<boolean>(store, "turnstileOnCheckin", false);
  if (turnstileRequired && !(await verifyTurnstile(c.env, typeof body.turnstileToken === "string" ? body.turnstileToken : undefined, "checkin", new URL(c.req.url).hostname, c.req.header("cf-connecting-ip")))) {
    return c.json({ error: "Human verification failed." }, 422);
  }
  const rewardRange = await readCheckinRewardRange(store);
  if (!rewardRange) return c.json({ error: "Check-in reward configuration is invalid." }, 503);
  if (rewardRange.maxRewardBytes === 0) return c.json({ error: "Check-in rewards are disabled." }, 422);
  const configuredTimeZone = await readSetting<unknown>(store, "timezone", "UTC");
  const timeZone = typeof configuredTimeZone === "string" && configuredTimeZone ? configuredTimeZone : "UTC";
  const userId = c.get("user").id;
  const lockName = `payment-user:${userId}`;
  const lockOwner = crypto.randomUUID();
  if (!(await store.acquireLease(lockName, lockOwner, Date.now() + 60_000))) return c.json({ error: "Another account update is being processed." }, 409);
  let updatedUser: User | null = null;
  let rewardBytes = 0;
  const checkedInAt = new Date().toISOString();
  try {
    const current = await store.get<User>("users", userId);
    if (!current || !current.enabled) return c.json({ error: "Account is unavailable." }, 401);
    const today = dateInTimeZone(new Date(checkedInAt), timeZone);
    const lastCheckinDate = current.lastCheckinAt && !Number.isNaN(Date.parse(current.lastCheckinAt))
      ? dateInTimeZone(new Date(current.lastCheckinAt), timeZone)
      : null;
    if (lastCheckinDate === today) return c.json({ error: "You have already checked in today." }, 409);
    rewardBytes = randomCheckinReward(rewardRange);
    const nextTrafficBytes = current.planTrafficBytes + rewardBytes;
    if (!Number.isSafeInteger(nextTrafficBytes) || current.planTrafficBytes < 0) return c.json({ error: "Account traffic quota cannot accept this reward." }, 422);
    const nextStreak = lastCheckinDate === previousCalendarDay(today) && Number.isSafeInteger(current.checkinStreak) && current.checkinStreak >= 0
      ? current.checkinStreak + 1
      : 1;
    const patch = {
      planTrafficBytes: nextTrafficBytes,
      checkinStreak: Number.isSafeInteger(nextStreak) ? nextStreak : 1,
      lastCheckinAt: checkedInAt,
      updatedAt: checkedInAt,
    };
    updatedUser = await store.patchUser(userId, patch);
    if (!updatedUser) return c.json({ error: "Account is unavailable." }, 401);
  } finally {
    await store.releaseLease(lockName, lockOwner);
  }

  let syncStatus: "synced" | "partial" | "failed" = "failed";
  try {
    const sync = await syncUserEntitlements(store, c.env, userId);
    syncStatus = sync.status;
    if (sync.status !== "synced") console.error(JSON.stringify({ event: "checkin_entitlement_sync_pending", userId, status: sync.status, failedNodes: sync.failed }));
  } catch (error) {
    console.error(JSON.stringify({ event: "checkin_entitlement_sync_failed", userId, message: error instanceof Error ? error.message : "unknown" }));
  }
  return c.json({ checkinStreak: updatedUser.checkinStreak, lastCheckinAt: updatedUser.lastCheckinAt, rewardBytes, planTrafficBytes: updatedUser.planTrafficBytes, syncStatus });
});

userApi.get("/overview", async (c) => {
  const store = c.get("store");
  const user = c.get("user");
  const [plan, dailyUsage, inbounds, bindings, nodes, mappings, configuredReward, configuredTimeZone] = await Promise.all([
    store.get<Plan>("plans", user.planId),
    listAll<DailyUsage>(store, "daily-usage", `${user.id}:`),
    listAll<Inbound>(store, "inbounds"),
    listAll<InboundNodeBinding>(store, "inbound-node-bindings"),
    listAll<NodeRecord>(store, "nodes"),
    listAll<ClientMapping>(store, "clients", `${user.id}:`),
    readCheckinRewardRange(store),
    readSetting<unknown>(store, "timezone", "UTC"),
  ]);
  const availableInbounds = new Set(inbounds.filter((inbound) => servesPlan(inbound, user)).map((inbound) => inbound.id));
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const activeBindings = bindings.filter((binding) => availableInbounds.has(binding.inboundId));
  const activeNodes = [...new Map(activeBindings.flatMap((binding) => {
    const node = nodeMap.get(binding.nodeId);
    return node?.enabled ? [[node.id, node] as const] : [];
  })).values()].sort(compareNodes);
  const now = new Date();
  const timeZone = typeof configuredTimeZone === "string" && configuredTimeZone ? configuredTimeZone : "UTC";
  const today = dateInTimeZone(now, timeZone);
  const lastCheckinDay = user.lastCheckinAt && !Number.isNaN(Date.parse(user.lastCheckinAt))
    ? dateInTimeZone(new Date(user.lastCheckinAt), timeZone)
    : null;
  const { minRewardBytes, maxRewardBytes } = configuredReward ?? { minRewardBytes: 0, maxRewardBytes: 0 };
  const usageToday = now.toISOString().slice(0, 10);
  const usage = dailyUsage.filter((item) => item.usageDay >= new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10) && item.usageDay <= usageToday);
  return c.json({
    user: publicUser(user),
    plan: plan ?? null,
    subscriptionActive: planIsActive(user),
    usage: {
      usedBytes: user.billedBytes,
      limitBytes: user.planTrafficBytes,
      remainingBytes: Math.max(0, user.planTrafficBytes - user.billedBytes),
      days: usage,
    },
    nodes: activeNodes.map((node) => ({ id: node.id, name: node.name, region: node.region, publicAddress: node.publicAddress, status: node.status, inboundCount: activeBindings.filter((binding) => binding.nodeId === node.id).length })),
    clients: mappings.filter((mapping) => availableInbounds.has(mapping.inboundId)).map(({ encryptedSecret: _secret, ...mapping }) => mapping),
    balanceMinor: user.balanceMinor,
    capabilities: { trafficMetering: store instanceof D1Store, quotaEnforcement: store instanceof D1Store, atomicPaymentSettlement: store instanceof D1Store },
    attendance: { streak: user.checkinStreak, lastCheckinAt: user.lastCheckinAt, checkedInToday: lastCheckinDay === today, rewardBytes: minRewardBytes, minRewardBytes, maxRewardBytes },
  });
});

userApi.get("/plans", async (c) => {
  const items = await listAll<Plan>(c.get("store"), "plans");
  return c.json({ items: items.filter((plan) => plan.enabled && plan.hidden !== true).sort((a, b) => a.level - b.level || a.priceMinor - b.priceMinor) });
});

userApi.get("/usage", async (c) => {
  const store = c.get("store");
  const user = c.get("user");
  const daysParam = Number(c.req.query("days") ?? 30);
  const days = Number.isInteger(daysParam) ? Math.min(Math.max(daysParam, 1), 30) : 30;
  const start = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const items = (await listAll<DailyUsage>(store, "daily-usage", `${user.id}:`))
    .filter((item) => item.usageDay >= start)
    .sort((a, b) => a.usageDay.localeCompare(b.usageDay));
  return c.json({ days, totalRawBytes: items.reduce((sum, item) => sum + item.rawBytes, 0), totalBilledBytes: items.reduce((sum, item) => sum + item.billedBytes, 0), items, meteringEnabled: store instanceof D1Store });
});

userApi.get("/nodes", async (c) => {
  const store = c.get("store");
  const user = c.get("user");
  const [inbounds, bindings, nodes, mappings] = await Promise.all([
    listAll<Inbound>(store, "inbounds"),
    listAll<InboundNodeBinding>(store, "inbound-node-bindings"),
    listAll<NodeRecord>(store, "nodes"),
    listAll<ClientMapping>(store, "clients", `${user.id}:`),
  ]);
  const inboundMap = new Map(inbounds.filter((inbound) => servesPlan(inbound, user)).map((inbound) => [inbound.id, inbound]));
  const clientMap = new Map(mappings.map((mapping) => [mapping.inboundId, mapping]));
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const items = bindings.flatMap((binding) => {
    const node = nodesById.get(binding.nodeId);
    const inbound = inboundMap.get(binding.inboundId);
    if (!node?.enabled || !inbound) return [];
    const mapping = clientMap.get(inbound.id);
    return [{
      node: { id: node.id, name: node.name, region: node.region, sortIndex: node.sortIndex ?? 0, publicAddress: node.publicAddress, status: node.status },
      inbound: { id: inbound.id, name: inbound.name, protocol: inbound.protocol, network: inbound.network, port: inbound.port, multiplier: inbound.multiplier },
      client: mapping ? { email: mapping.email, clientId: mapping.clientId, enabled: mapping.enable, syncStatus: mapping.syncStatus } : null,
    }];
  });
  items.sort((a, b) => compareNodes(a.node, b.node));
  return c.json({ items });
});

userApi.get("/notifications", async (c) => {
  const userId = c.get("user").id;
  const items = (await listAll<UserNotification>(c.get("store"), "notifications", `${userId}:`))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(({ id, type, title, body, createdAt, readAt }) => ({ id, type, title, body, createdAt, readAt }));
  return c.json({ items, unreadCount: items.filter((item) => item.readAt === null).length });
});

userApi.post("/notifications/:id/read", async (c) => {
  const userId = c.get("user").id;
  const store = c.get("store");
  const recordId = notificationRecordId(userId, c.req.param("id"));
  const notification = await store.get<UserNotification>("notifications", recordId);
  if (!notification || notification.userId !== userId) return c.json({ error: "Notification not found." }, 404);
  if (!notification.readAt) {
    notification.readAt = new Date().toISOString();
    await store.put("notifications", recordId, notification);
  }
  return c.json({ notification: { id: notification.id, readAt: notification.readAt } });
});

userApi.get("/orders", async (c) => {
  const user = c.get("user");
  const items = (await listAll<Order>(c.get("store"), "orders"))
    .filter((order) => order.userId === user.id)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return c.json({ items, count: items.length });
});

userApi.post("/subscription/:action", async (c) => {
  const action = c.req.param("action");
  if (action !== "links" && action !== "reset") return c.json({ error: "Not found." }, 404);
  c.header("Cache-Control", "private, no-store");
  c.header("Referrer-Policy", "no-referrer");
  if (!c.env.APP_ENCRYPTION_KEY || c.env.APP_ENCRYPTION_KEY.length < 32) return c.json({ error: "Subscription encryption is not configured." }, 503);
  try {
    const credential = await subscriptionCredential(c.get("store"), c.get("user").id, c.env.APP_ENCRYPTION_KEY, action === "reset");
    const base = `${new URL(c.req.url).origin}/api/subscriptions/${credential.token}`;
    return c.json({
      links: { clash: `${base}?format=clash`, v2ray: `${base}?format=v2ray`, shadowsocks: `${base}?format=shadowsocks` },
      formats: { clash: { label: "Clash / Mihomo" }, v2ray: { label: "V2Ray / v2rayN" }, shadowsocks: { label: "Shadowsocks / SIP008", note: "Only compatible Shadowsocks nodes with verified credentials are included." } },
      updatedAt: credential.updatedAt,
    });
  } catch {
    return c.json({ error: "Subscription links are temporarily unavailable. Please retry." }, 503);
  }
});

userApi.get("/subscription", async (c) => {
  const store = c.get("store");
  const user = c.get("user");
  const [plan, inbounds, mappings] = await Promise.all([
    store.get<Plan>("plans", user.planId),
    listAll<Inbound>(store, "inbounds"),
    listAll<ClientMapping>(store, "clients", `${user.id}:`),
  ]);
  const inboundMap = new Map(inbounds.map((inbound) => [inbound.id, inbound]));
  const clients = mappings.flatMap((mapping) => {
    const inbound = inboundMap.get(mapping.inboundId);
    if (!inbound || !servesPlan(inbound, user)) return [];
    return [{ inboundId: inbound.id, inboundName: inbound.name, protocol: inbound.protocol, port: inbound.port, enabled: mapping.enable, syncStatus: mapping.syncStatus }];
  });
  return c.json({
    plan: plan ?? null,
    active: planIsActive(user),
    startedAt: user.planStartedAt,
    expiresAt: user.planExpiresAt,
    traffic: { usedBytes: user.billedBytes, limitBytes: user.planTrafficBytes, remainingBytes: Math.max(0, user.planTrafficBytes - user.billedBytes) },
    clients,
    capabilities: { trafficMetering: store instanceof D1Store, quotaEnforcement: store instanceof D1Store, atomicPaymentSettlement: store instanceof D1Store },
  });
});

export default userApi;
