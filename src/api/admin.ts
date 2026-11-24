import { Hono } from "hono";
import { businessSettingKeys, prepareBusinessSettings, publicSettings, validateBusinessSetting } from "../services/settings";
import type { Context } from "hono";
import { FREE_PLAN_ID, defaultPlan, ensureDefaultPlan, readCheckinRewardRange, readSetting, servesPlan, writeSetting } from "../domain/defaults";
import { encryptSecret, hashPassword } from "../domain/security";
import type { ApiEnv } from "./context";
import { requireAdmin, validateSameOrigin } from "./context";
import type { ClientMapping, Inbound, InboundNodeBinding, Invite, NodeRecord, Order, Plan, User } from "../domain/types";
import { validatePanelUrl, probeNode, ThreeXuiClient, readPanelClients, type XuiInbound } from "../adapters/xui/client";
import { syncClientToNodes, syncUserEntitlements } from "../services/xui-sync";
import { D1Store } from "../storage/d1";
import type { DocumentStore, Page } from "../storage/store";

const admin = new Hono<ApiEnv>();
const now = () => new Date().toISOString();
const resetUnits = new Set(["none", "day", "week", "month", "year", "fixed_daily", "fixed_weekly", "fixed_monthly"]);

admin.use("*", async (c, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method) && !validateSameOrigin(c.req.raw)) return c.json({ error: "Request origin is not allowed." }, 403);
  await next();
});

async function parseBody(c: Context<ApiEnv>): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function safeNode(node: NodeRecord) {
  const { encryptedPassword: _password, apiTokenEncrypted: _token, ...safe } = node;
  return safe;
}

/** 3X-UI returns nested inbound settings either as objects or as JSON strings. */
function panelObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const trafficResetUnits = new Set(["never", "hourly", "daily", "weekly", "monthly"]);
const shareAddrStrategyUnits = new Set(["node", "listen", "custom"]);

/** Validates the inbound-level fields 3X-UI stores beside settings/streamSettings/sniffing. */
function inboundMeta(body: Record<string, unknown>): Partial<Inbound> {
  const meta: Partial<Inbound> = {};
  if (typeof body.listen === "string") meta.listen = body.listen.trim().slice(0, 255);
  if (typeof body.total === "number" && Number.isSafeInteger(body.total) && body.total >= 0) meta.total = body.total;
  if (typeof body.expiryTime === "number" && Number.isSafeInteger(body.expiryTime) && body.expiryTime >= 0) meta.expiryTime = body.expiryTime;
  if (typeof body.trafficReset === "string" && trafficResetUnits.has(body.trafficReset)) meta.trafficReset = body.trafficReset as Inbound["trafficReset"];
  if (typeof body.trafficResetDay === "number" && Number.isInteger(body.trafficResetDay) && body.trafficResetDay >= 0 && body.trafficResetDay <= 31) meta.trafficResetDay = body.trafficResetDay;
  if (typeof body.tag === "string") meta.tag = body.tag.trim().slice(0, 64);
  if (typeof body.shareAddrStrategy === "string" && shareAddrStrategyUnits.has(body.shareAddrStrategy)) meta.shareAddrStrategy = body.shareAddrStrategy as Inbound["shareAddrStrategy"];
  if (typeof body.shareAddr === "string") meta.shareAddr = body.shareAddr.trim().slice(0, 255);
  if (typeof body.subSortIndex === "number" && Number.isInteger(body.subSortIndex) && body.subSortIndex >= 0 && body.subSortIndex <= 9999) meta.subSortIndex = body.subSortIndex;
  if (typeof body.excludeFromSub === "boolean") meta.excludeFromSub = body.excludeFromSub;
  if (typeof body.disableFlow === "boolean") meta.disableFlow = body.disableFlow;
  if (typeof body.defaultFlow === "string" && body.defaultFlow.length <= 64) meta.defaultFlow = body.defaultFlow;
  return meta;
}

/** Copies the inbound-level 3X-UI fields of a panel inbound onto a local record. */
function panelMeta(source: XuiInbound): Partial<Inbound> {
  return inboundMeta({
    listen: source.listen ?? "",
    total: source.total ?? 0,
    expiryTime: source.expiryTime ?? 0,
    trafficReset: source.trafficReset ?? "never",
    trafficResetDay: source.trafficResetDay ?? 0,
    tag: source.tag ?? "",
    shareAddrStrategy: source.shareAddrStrategy ?? "node",
    shareAddr: source.shareAddr ?? "",
    subSortIndex: source.subSortIndex ?? 1,
    excludeFromSub: source.excludeFromSub === true,
    disableFlow: source.disableFlow === true,
  });
}

async function listAll<T>(store: DocumentStore, collection: string, prefix?: string): Promise<T[]> {
  const results: T[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<T> = await store.list<T>(collection, { limit: 100, cursor, prefix });
    results.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return results;
}

admin.get("/dashboard", requireAdmin, async (c) => {
  const store = c.get("store");
  const [users, plans, nodes, orders] = await Promise.all([
    listAll<User>(store, "users"), listAll<Plan>(store, "plans"), listAll<NodeRecord>(store, "nodes"), listAll<Order>(store, "orders"),
  ]);
  const month = new Date();
  month.setUTCDate(1);
  const paidOrders = orders.filter((order) => order.status === "paid" && order.provider !== "manual" && Date.parse(order.paidAt ?? order.createdAt) >= month.getTime());
  return c.json({
    users: users.length,
    activeUsers: users.filter((user) => user.enabled).length,
    activeSubscriptions: users.filter((user) => user.planId !== "plan-free" && (!user.planExpiresAt || Date.parse(user.planExpiresAt) > Date.now())).length,
    revenueMinor: paidOrders.reduce((sum, order) => sum + order.amountMinor, 0),
    currency: paidOrders[0]?.currency ?? "USD",
    nodesOnline: nodes.filter((node) => node.status === "online").length,
    nodesTotal: nodes.length,
    plans: plans.length,
    pendingOrders: orders.filter((order) => order.status === "pending").length,
  });
});

admin.get("/users", requireAdmin, async (c) => {
  const store = c.get("store");
  const query = (c.req.query("q") ?? "").toLocaleLowerCase();
  const users = await listAll<User>(store, "users");
  const items = users.filter((user) => !query || user.email.toLocaleLowerCase().includes(query)).map(({ passwordHash: _passwordHash, ...user }) => user);
  return c.json({ items, count: items.length });
});

admin.post("/users", requireAdmin, async (c) => {
  const store = c.get("store");
  const body = await parseBody(c);
  if (!body) return c.json({ error: "Invalid request body." }, 400);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return c.json({ error: "Enter a valid email address." }, 422);
  if (password.length < 12 || password.length > 256) return c.json({ error: "Password must contain 12 to 256 characters." }, 422);
  if (await store.has("user-email", email)) return c.json({ error: "An account with this email already exists." }, 409);
  const requestedPlanId = typeof body.planId === "string" && body.planId ? body.planId : FREE_PLAN_ID;
  const plan = await store.get<Plan>("plans", requestedPlanId) ?? (requestedPlanId === FREE_PLAN_ID ? defaultPlan : null);
  if (!plan) return c.json({ error: "Plan not found." }, 422);
  const timestamp = now();
  const user: User = {
    id: crypto.randomUUID(), email, passwordHash: await hashPassword(password), emailVerifiedAt: timestamp,
    role: body.role === "admin" ? "admin" : "user",
    balanceMinor: await readSetting<number>(store, "defaultBalanceMinor", 0),
    planId: plan.id,
    planLevel: plan.level,
    planExpiresAt: plan.validityDays > 0 ? new Date(Date.now() + plan.validityDays * 86400000).toISOString() : null,
    planTrafficBytes: plan.trafficBytes,
    billedBytes: 0, planStartedAt: timestamp, trafficResetAt: null, enabled: body.enabled !== false,
    inviteCode: null, invitedBy: null, inviteCount: 0, checkinStreak: 0,
    lastCheckinAt: null, lastActiveAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
  };
  await store.put("users", user.id, user);
  await store.put("user-email", user.email, { userId: user.id });
  const sync = await syncUserEntitlements(store, c.env, user.id).catch((error: unknown) => {
    console.error(JSON.stringify({ event: "admin_user_sync_failed", userId: user.id, message: error instanceof Error ? error.message : "unknown" }));
    return null;
  });
  const { passwordHash: _passwordHash, ...safe } = user;
  return c.json({ user: safe, sync }, { status: 201 });
});

admin.patch("/users/:id", requireAdmin, async (c) => {
  const store = c.get("store");
  const id = c.req.param("id") ?? "";
  const body = await parseBody(c);
  if (!body) return c.json({ error: "Invalid request body." }, 400);
  const lockName = `payment-user:${id}`;
  const lockOwner = crypto.randomUUID();
  if (!(await store.acquireLease(lockName, lockOwner, Date.now() + 60_000))) return c.json({ error: "Another account update is being processed." }, 409);
  let user: User;
  try {
    const current = await store.get<User>("users", id);
    if (!current) return c.json({ error: "User not found." }, 404);
    user = current;
    const patch: Partial<User> = {};
    if (typeof body.enabled === "boolean") patch.enabled = user.enabled = body.enabled;
    if (body.role === "admin" || body.role === "user") patch.role = user.role = body.role;
    if (typeof body.balanceMinor === "number" && Number.isSafeInteger(body.balanceMinor) && body.balanceMinor >= 0) patch.balanceMinor = user.balanceMinor = body.balanceMinor;
    if (typeof body.billedBytes === "number" && Number.isSafeInteger(body.billedBytes) && body.billedBytes >= 0) patch.billedBytes = user.billedBytes = body.billedBytes;
    if (typeof body.planId === "string") {
      const plan = await store.get<Plan>("plans", body.planId);
      if (!plan) return c.json({ error: "Plan not found." }, 422);
      user.planId = plan.id;
      user.planLevel = plan.level;
      user.planTrafficBytes = plan.trafficBytes;
      user.planStartedAt = now();
      user.planExpiresAt = plan.validityDays > 0 ? new Date(Date.now() + plan.validityDays * 86400000).toISOString() : null;
      user.billedBytes = 0;
      user.trafficResetAt = null;
      Object.assign(patch, {
        planId: user.planId, planLevel: user.planLevel, planTrafficBytes: user.planTrafficBytes,
        planStartedAt: user.planStartedAt, planExpiresAt: user.planExpiresAt, billedBytes: user.billedBytes, trafficResetAt: user.trafficResetAt,
      });
    }
    if (typeof body.planExpiresAt === "string" || body.planExpiresAt === null) patch.planExpiresAt = user.planExpiresAt = body.planExpiresAt as string | null;
    patch.updatedAt = user.updatedAt = now();
    if (store instanceof D1Store) {
      const updated = await store.patchUser(id, patch);
      if (!updated) return c.json({ error: "User not found." }, 404);
      user = updated;
    } else {
      await store.put("users", id, user);
    }
  } finally {
    await store.releaseLease(lockName, lockOwner);
  }
  const sync = await syncUserEntitlements(store, c.env, id);
  const { passwordHash: _passwordHash, ...safe } = user;
  return c.json({ user: safe, sync });
});

admin.post("/users/:id/balance", requireAdmin, async (c) => {
  const store = c.get("store");
  if (!(store instanceof D1Store)) return c.json({ error: "Balance adjustments require D1 atomic storage." }, 503);
  const id = c.req.param("id") ?? "";
  const body = await parseBody(c);
  if (!body) return c.json({ error: "Invalid request body." }, 400);
  const action = body.action === "credit" || body.action === "refund" ? body.action : null;
  if (!action) return c.json({ error: "Choose whether to credit or refund this account." }, 422);
  const amountMinor = body.amountMinor;
  if (typeof amountMinor !== "number" || !Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > 100_000_000) return c.json({ error: "The adjustment amount is out of range." }, 422);
  const currency = typeof body.currency === "string" ? body.currency.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(currency)) return c.json({ error: "Currency must be a three-letter ISO code." }, 422);
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 200) : "";
  const user = await store.get<User>("users", id);
  if (!user) return c.json({ error: "User not found." }, 404);
  if (action === "credit" && !Number.isSafeInteger(user.balanceMinor + amountMinor)) return c.json({ error: "The resulting balance exceeds the safe integer range." }, 422);
  const timestamp = now();
  const order: Order = {
    id: crypto.randomUUID().replaceAll("-", ""), userId: user.id, planId: null, type: "topup",
    amountMinor, currency, provider: "manual", providerOrderId: null, checkoutUrl: null,
    status: action === "credit" ? "paid" : "refunded", expiresAt: timestamp,
    paidAt: action === "credit" ? timestamp : null,
    metadata: { kind: action === "credit" ? "manual_credit" : "manual_refund", note, actorId: c.get("user").id },
    createdAt: timestamp, updatedAt: timestamp,
  };
  const applied = await store.adjustUserBalanceOnce({ userId: user.id, orderId: order.id, amountMinor, currency, createdAt: timestamp, action });
  if (!applied) return c.json({ error: "This account does not have enough balance for the refund." }, 409);
  await store.put("orders", order.id, order);
  const updated = await store.get<User>("users", id) ?? user;
  const { passwordHash: _passwordHash, ...safe } = updated;
  return c.json({ user: safe, order }, { status: 201 });
});

admin.get("/plans", requireAdmin, async (c) => {
  const store = c.get("store");
  await ensureDefaultPlan(store);
  return c.json({ items: await listAll<Plan>(store, "plans") });
});

admin.post("/plans", requireAdmin, async (c) => {
  const body = await parseBody(c);
  if (!body || typeof body.name !== "string" || body.name.trim().length < 2) return c.json({ error: "A plan name is required." }, 422);
  const values = planValues(body);
  if (!values) return c.json({ error: "Plan values are invalid." }, 422);
  const plan: Plan = { id: crypto.randomUUID(), ...values, isDefault: false, createdAt: now(), updatedAt: now() };
  await c.get("store").put("plans", plan.id, plan);
  return c.json({ plan }, 201);
});

admin.patch("/plans/:id", requireAdmin, async (c) => {
  const store = c.get("store");
  await ensureDefaultPlan(store);
  const id = c.req.param("id") ?? "";
  const plan = await store.get<Plan>("plans", id);
  if (!plan) return c.json({ error: "Plan not found." }, 404);
  const body = await parseBody(c);
  if (!body) return c.json({ error: "Invalid request body." }, 400);
  const values = planValues({ ...plan, ...body });
  if (!values) return c.json({ error: "Plan values are invalid." }, 422);
  Object.assign(plan, values, { updatedAt: now() });
  if (plan.isDefault && (plan.priceMinor !== 0 || plan.level !== 0)) return c.json({ error: "The default plan must keep level and price at zero." }, 422);
  await store.put("plans", id, plan);
  return c.json({ plan });
});

admin.delete("/plans/:id", requireAdmin, async (c) => {
  const store = c.get("store");
  const id = c.req.param("id") ?? "";
  const plan = await store.get<Plan>("plans", id);
  if (!plan) return c.json({ error: "Plan not found." }, 404);
  if (plan.isDefault) return c.json({ error: "The default plan cannot be deleted." }, 403);
  const users = await listAll<User>(store, "users");
  if (users.some((user) => user.planId === id)) return c.json({ error: "This plan is assigned to users and cannot be deleted." }, 409);
  await store.delete("plans", id);
  return c.json({ ok: true });
});

admin.get("/nodes", requireAdmin, async (c) => {
  const nodes = await listAll<NodeRecord>(c.get("store"), "nodes");
  return c.json({ items: nodes.map(safeNode), count: nodes.length });
});

admin.post("/nodes", requireAdmin, async (c) => {
  const body = await parseBody(c);
  if (!body || typeof body.name !== "string" || typeof body.panelUrl !== "string") return c.json({ error: "Node name and panel URL are required." }, 422);
  if (!c.env.APP_ENCRYPTION_KEY) return c.json({ error: "Set APP_ENCRYPTION_KEY before registering nodes." }, 503);
  try { validatePanelUrl(body.panelUrl); } catch (error) { return c.json({ error: error instanceof Error ? error.message : "Invalid panel URL." }, 422); }
  const password = typeof body.password === "string" ? body.password : "";
  const token = typeof body.apiToken === "string" ? body.apiToken : "";
  if (!password && !token) return c.json({ error: "Provide a panel password or scoped API token." }, 422);
  const record: NodeRecord = {
    id: crypto.randomUUID(), name: body.name.trim().slice(0, 80), region: typeof body.region === "string" ? body.region.slice(0, 80) : "",
    panelUrl: body.panelUrl, publicAddress: typeof body.publicAddress === "string" ? body.publicAddress : "",
    username: typeof body.username === "string" ? body.username : "", encryptedPassword: await encryptSecret(password, c.env.APP_ENCRYPTION_KEY),
    apiTokenEncrypted: token ? await encryptSecret(token, c.env.APP_ENCRYPTION_KEY) : null,
    basePath: typeof body.basePath === "string" ? body.basePath : "/", status: "unknown", supportedApi: null,
    lastCheckedAt: null, inboundCount: 0, syncStatus: "pending", lastSyncAt: null, lastError: null,
    enabled: body.enabled !== false, createdAt: now(), updatedAt: now(),
  };
  const probe = await probeNode(c.env, record);
  Object.assign(record, { status: probe.status, supportedApi: probe.clientApi, lastCheckedAt: probe.checkedAt, inboundCount: probe.inbounds, lastError: probe.error ?? null });
  await c.get("store").put("nodes", record.id, record);
  return c.json({ node: safeNode(record), probe }, { status: probe.status === "online" ? 201 : 202 });
});

admin.post("/nodes/:id/test", requireAdmin, async (c) => {
  const node = await c.get("store").get<NodeRecord>("nodes", c.req.param("id") ?? "");
  if (!node) return c.json({ error: "Node not found." }, 404);
  const probe = await probeNode(c.env, node);
  node.status = probe.status;
  node.supportedApi = probe.clientApi;
  node.lastCheckedAt = probe.checkedAt;
  node.inboundCount = probe.inbounds;
  node.lastError = probe.error ?? null;
  node.updatedAt = now();
  await c.get("store").put("nodes", node.id, node);
  return c.json({ probe, node: safeNode(node) });
});

admin.post("/nodes/:id/vless-keys", requireAdmin, async (c) => {
  const node = await c.get("store").get<NodeRecord>("nodes", c.req.param("id") ?? "");
  if (!node) return c.json({ error: "Node not found." }, 404);
  if (!node.enabled) return c.json({ error: "Node is disabled." }, 422);
  try {
    const items = await (await ThreeXuiClient.connect(c.env, node)).newVlessEnc();
    return c.json({ items });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unable to generate VLESS keys." }, 502);
  }
});

admin.patch("/nodes/:id", requireAdmin, async (c) => {
  const store = c.get("store");
  const node = await store.get<NodeRecord>("nodes", c.req.param("id") ?? "");
  if (!node) return c.json({ error: "Node not found." }, 404);
  const body = await parseBody(c);
  if (!body) return c.json({ error: "Invalid request body." }, 400);
  if (!c.env.APP_ENCRYPTION_KEY) return c.json({ error: "APP_ENCRYPTION_KEY is not configured." }, 503);
  if (typeof body.panelUrl === "string") {
    try { validatePanelUrl(body.panelUrl); } catch (error) { return c.json({ error: error instanceof Error ? error.message : "Invalid panel URL." }, 422); }
    node.panelUrl = body.panelUrl;
  }
  if (typeof body.name === "string") node.name = body.name.trim().slice(0, 80);
  if (typeof body.region === "string") node.region = body.region.slice(0, 80);
  if (typeof body.publicAddress === "string") node.publicAddress = body.publicAddress.slice(0, 255);
  if (typeof body.username === "string") node.username = body.username.slice(0, 100);
  if (typeof body.basePath === "string") node.basePath = body.basePath.slice(0, 200);
  if (typeof body.password === "string" && body.password) node.encryptedPassword = await encryptSecret(body.password, c.env.APP_ENCRYPTION_KEY);
  if (typeof body.apiToken === "string") node.apiTokenEncrypted = body.apiToken ? await encryptSecret(body.apiToken, c.env.APP_ENCRYPTION_KEY) : null;
  if (typeof body.enabled === "boolean") node.enabled = body.enabled;
  node.updatedAt = now();
  const probe = await probeNode(c.env, node);
  node.status = probe.status;
  node.supportedApi = probe.clientApi;
  node.lastCheckedAt = probe.checkedAt;
  node.inboundCount = probe.inbounds;
  node.lastError = probe.error ?? null;
  await store.put("nodes", node.id, node);
  const mappings = await listAll<ClientMapping>(store, "clients");
  const syncResults = await Promise.all(mappings.filter((mapping) => mapping.syncedNodes.includes(node.id)).map((mapping) => syncClientToNodes(store, c.env, mapping)));
  return c.json({ node: safeNode(node), probe, mappingsResynced: syncResults.length });
});

admin.delete("/nodes/:id", requireAdmin, async (c) => {
  const store = c.get("store");
  const nodeId = c.req.param("id") ?? "";
  const node = await store.get<NodeRecord>("nodes", nodeId);
  if (!node) return c.json({ error: "Node not found." }, 404);
  const mappings = await listAll<ClientMapping>(store, "clients");
  const inboundsById = new Map((await listAll<Inbound>(store, "inbounds")).map((item) => [item.id, item]));
  const failures: string[] = [];
  for (const mapping of mappings.filter((item) => item.syncedNodes.includes(nodeId))) {
    // A WireGuard peer only lives in the inbound settings, so removing the node removes it too.
    if (inboundsById.get(mapping.inboundId)?.protocol.toLowerCase() === "wireguard") continue;
    try {
      const client = await ThreeXuiClient.connect(c.env, node);
      await client.deleteClient(mapping);
    } catch (error) { failures.push(error instanceof Error ? error.message : "client cleanup failed"); }
  }
  if (failures.length) return c.json({ error: "Unable to remove all remote clients; the node remains registered.", failures: failures.slice(0, 10) }, 409);
  const bindings = await listAll<InboundNodeBinding>(store, "inbound-node-bindings");
  for (const binding of bindings.filter((item) => item.nodeId === nodeId)) await store.delete("inbound-node-bindings", binding.id);
  for (const mapping of mappings) {
    mapping.syncedNodes = mapping.syncedNodes.filter((id) => id !== nodeId);
    await store.put("clients", mapping.id, mapping);
  }
  await store.delete("nodes", nodeId);
  return c.json({ ok: true });
});

admin.get("/inbounds", requireAdmin, async (c) => {
  const store = c.get("store");
  const [items, bindings, clients] = await Promise.all([
    listAll<Inbound>(store, "inbounds"),
    listAll<InboundNodeBinding>(store, "inbound-node-bindings"),
    listAll<ClientMapping>(store, "clients"),
  ]);
  const sync = items.map((inbound) => ({ inboundId: inbound.id, nodes: bindings.filter((binding) => binding.inboundId === inbound.id).length, clients: clients.filter((client) => client.inboundId === inbound.id).length }));
  return c.json({ items, bindings, sync });
});

admin.post("/inbounds", requireAdmin, async (c) => {
  const body = await parseBody(c);
  if (!body || typeof body.name !== "string" || typeof body.protocol !== "string" || typeof body.port !== "number" || !Array.isArray(body.nodeIds)) return c.json({ error: "Name, protocol, port, and selected nodes are required." }, 422);
  const nodeIds = [...new Set(body.nodeIds.filter((id): id is string => typeof id === "string"))];
  const level = typeof body.minimumLevel === "number" ? body.minimumLevel : 0;
  const multiplier = typeof body.multiplier === "number" ? body.multiplier : 1;
  if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535 || !Number.isInteger(level) || level < 0 || multiplier < 0 || multiplier > 100) return c.json({ error: "Port, minimum level, or multiplier is out of range." }, 422);
  if (nodeIds.length === 0) return c.json({ error: "Select at least one node." }, 422);
  const store = c.get("store");
  const nodes = await Promise.all(nodeIds.map((id) => store.get<NodeRecord>("nodes", id)));
  if (nodes.some((node) => !node || !node.enabled)) return c.json({ error: "One or more selected nodes are unavailable." }, 422);
  const config = body.config && typeof body.config === "object" && !Array.isArray(body.config) ? body.config as Record<string, unknown> : {};
  const planEnabled = body.planEnabled !== false;
  const planIds = [...new Set(Array.isArray(body.planIds) ? body.planIds.filter((id): id is string => typeof id === "string") : [])];
  if (planIds.length) {
    const selected = await Promise.all(planIds.map((id) => store.get<Plan>("plans", id)));
    if (selected.some((plan) => !plan)) return c.json({ error: "One or more selected plans are unavailable." }, 422);
  }
  const inbound: Inbound = {
    id: crypto.randomUUID(), name: body.name.trim().slice(0, 100), protocol: body.protocol.toLowerCase(),
    network: typeof body.network === "string" ? body.network : "tcp", port: body.port, minimumLevel: level,
    multiplier, enabled: body.enabled !== false, planEnabled, planIds, config, ...inboundMeta(body), createdAt: now(), updatedAt: now(),
  };
  const failures: Array<{ nodeId: string; message: string }> = [];
  const createdBindings: InboundNodeBinding[] = [];
  await store.put("inbounds", inbound.id, inbound);
  for (const node of nodes) {    if (!node) continue;
    try {
      const panel = await ThreeXuiClient.connect(c.env, node);
      const panelInboundId = await panel.addInbound(inbound);
      const binding: InboundNodeBinding = { id: `${inbound.id}:${node.id}`, inboundId: inbound.id, nodeId: node.id, panelInboundId, createdAt: now() };
      await store.put("inbound-node-bindings", binding.id, binding);
      createdBindings.push(binding);
      node.inboundCount += 1;
      node.lastSyncAt = now();
      node.syncStatus = "synced";
      await store.put("nodes", node.id, node);
    } catch (error) {
      failures.push({ nodeId: node.id, message: error instanceof Error ? error.message : "Inbound sync failed." });
    }
  }
  await store.put("inbound-sync", inbound.id, { inboundId: inbound.id, status: failures.length === 0 ? "synced" : createdBindings.length ? "partial" : "failed", failures, updatedAt: now() });
  if (inbound.planEnabled) {
    const users = await listAll<User>(store, "users");
    for (const user of users.filter((item) => item.enabled && servesPlan(inbound, item) && createdBindings.length)) {
      await syncUserEntitlements(store, c.env, user.id);
    }
  }
  return c.json({ inbound, bindings: createdBindings, failures, syncStatus: failures.length === 0 ? "synced" : createdBindings.length ? "partial" : "failed" }, { status: failures.length ? 207 : 201 });
});

admin.get("/inbounds/remote", requireAdmin, async (c) => {
  const store = c.get("store");
  const node = await store.get<NodeRecord>("nodes", c.req.query("nodeId") ?? "");
  if (!node) return c.json({ error: "Node not found." }, 404);
  if (!node.enabled) return c.json({ error: "Node is disabled." }, 422);
  try {
    const remote = await (await ThreeXuiClient.connect(c.env, node)).listInbounds();
    const bindings = await listAll<InboundNodeBinding>(store, "inbound-node-bindings");
    const imported = new Set(bindings.filter((binding) => binding.nodeId === node.id).map((binding) => binding.panelInboundId));
    const items = remote.map((item) => {
      const stream = panelObject(item.streamSettings);
      return {
        panelInboundId: item.id,
        name: (item.remark ?? "").trim() || `Inbound ${item.id}`,
        protocol: (item.protocol ?? "vless").toLowerCase(),
        port: typeof item.port === "number" ? item.port : 0,
        network: typeof stream.network === "string" ? stream.network : "tcp",
        security: typeof stream.security === "string" ? stream.security : "none",
        enabled: item.enable !== false,
        imported: imported.has(item.id),
      };
    });
    return c.json({ items, count: items.length });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unable to read panel inbounds." }, 502);
  }
});

/**
 * Read-only view of the panel-side clients of one inbound, so drift between the account and the
 * node can be inspected without opening 3X-UI. Secrets are never returned, only their presence.
 */
admin.get("/inbounds/:id/panel-clients", requireAdmin, async (c) => {
  const store = c.get("store");
  const inbound = await store.get<Inbound>("inbounds", c.req.param("id") ?? "");
  if (!inbound) return c.json({ error: "Inbound not found." }, 404);
  const bindings = await listAll<InboundNodeBinding>(store, "inbound-node-bindings", `${inbound.id}:`);
  const items: Array<Record<string, unknown>> = [];
  for (const binding of bindings) {
    if (binding.panelInboundId <= 0) continue;
    const node = await store.get<NodeRecord>("nodes", binding.nodeId);
    if (!node) continue;
    try {
      const client = await ThreeXuiClient.connect(c.env, node);
      const panelInbounds = await client.listInbounds();
      const rows = readPanelClients(panelInbounds, binding.panelInboundId);
      const usage = client.readClientUsage(panelInbounds, binding.panelInboundId);
      for (const [email, row] of rows ?? []) {
        items.push({
          nodeId: node.id,
          nodeName: node.name,
          email,
          enable: row.enable !== false,
          totalGB: Number(row.totalGB ?? 0),
          expiryTime: Number(row.expiryTime ?? 0),
          flow: typeof row.flow === "string" ? row.flow : "",
          hasAuth: typeof row.auth === "string" && row.auth.length > 0,
          usedBytes: usage.get(email) ?? 0,
        });
      }
    } catch (error) {
      items.push({ nodeId: node.id, nodeName: node.name, error: error instanceof Error ? error.message : "Unable to read panel clients." });
    }
  }
  return c.json({ items, count: items.length });
});

admin.post("/inbounds/import", requireAdmin, async (c) => {
  const body = await parseBody(c);
  if (!body || typeof body.nodeId !== "string" || !Array.isArray(body.panelInboundIds)) return c.json({ error: "A node and at least one inbound are required." }, 422);
  const requested = [...new Set(body.panelInboundIds.filter((id): id is number => typeof id === "number" && Number.isInteger(id)))].slice(0, 50);
  if (!requested.length) return c.json({ error: "A node and at least one inbound are required." }, 422);
  const store = c.get("store");
  const node = await store.get<NodeRecord>("nodes", body.nodeId);
  if (!node) return c.json({ error: "Node not found." }, 404);
  if (!node.enabled) return c.json({ error: "Node is disabled." }, 422);
  let remote: XuiInbound[];
  try {
    remote = await (await ThreeXuiClient.connect(c.env, node)).listInbounds();
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Unable to read panel inbounds." }, 502);
  }
  const bindings = await listAll<InboundNodeBinding>(store, "inbound-node-bindings");
  const alreadyBound = new Set(bindings.filter((binding) => binding.nodeId === node.id).map((binding) => binding.panelInboundId));
  const created: Inbound[] = [];
  const createdBindings: InboundNodeBinding[] = [];
  const skipped: number[] = [];
  for (const panelInboundId of requested) {
    const source = remote.find((item) => item.id === panelInboundId);
    if (!source || alreadyBound.has(panelInboundId)) { skipped.push(panelInboundId); continue; }
    const stream = panelObject(source.streamSettings);
    const inbound: Inbound = {
      id: crypto.randomUUID(),
      name: ((source.remark ?? "").trim() || `Inbound ${source.id}`).slice(0, 100),
      protocol: (source.protocol ?? "vless").toLowerCase(),
      network: typeof stream.network === "string" ? stream.network : "tcp",
      port: typeof source.port === "number" ? source.port : 0,
      minimumLevel: 0,
      multiplier: 1,
      enabled: source.enable !== false,
      planEnabled: false,
      ...panelMeta(source),
      config: {
        settings: panelObject(source.settings),
        streamSettings: stream,
        sniffing: panelObject(source.sniffing),
      },
      createdAt: now(),
      updatedAt: now(),
    };
    const binding: InboundNodeBinding = { id: `${inbound.id}:${node.id}`, inboundId: inbound.id, nodeId: node.id, panelInboundId, createdAt: now() };
    await store.put("inbounds", inbound.id, inbound);
    await store.put("inbound-node-bindings", binding.id, binding);
    await store.put("inbound-sync", inbound.id, { inboundId: inbound.id, status: "synced", failures: [], updatedAt: now() });
    created.push(inbound);
    createdBindings.push(binding);
  }
  if (created.length) {
    node.inboundCount += created.length;
    node.lastSyncAt = now();
    node.syncStatus = "synced";
    node.updatedAt = now();
    await store.put("nodes", node.id, node);
  }
  return c.json({ items: created, bindings: createdBindings, skipped, imported: created.length });
});

admin.patch("/inbounds/:id", requireAdmin, async (c) => {
  const store = c.get("store");
  const inbound = await store.get<Inbound>("inbounds", c.req.param("id") ?? "");
  if (!inbound) return c.json({ error: "Inbound not found." }, 404);
  const body = await parseBody(c);
  if (!body) return c.json({ error: "Invalid request body." }, 400);
  const next: Inbound = { ...inbound };
  if (typeof body.name === "string") next.name = body.name.trim().slice(0, 100);
  if (typeof body.protocol === "string") next.protocol = body.protocol.toLowerCase();
  if (typeof body.network === "string") next.network = body.network;
  if (typeof body.port === "number" && Number.isInteger(body.port) && body.port >= 1 && body.port <= 65535) next.port = body.port;
  if (typeof body.minimumLevel === "number" && Number.isInteger(body.minimumLevel) && body.minimumLevel >= 0) next.minimumLevel = body.minimumLevel;
  if (typeof body.multiplier === "number" && body.multiplier >= 0 && body.multiplier <= 100) next.multiplier = body.multiplier;
  if (typeof body.enabled === "boolean") next.enabled = body.enabled;
  if (typeof body.planEnabled === "boolean") next.planEnabled = body.planEnabled;
  let planBindingChanged = false;
  if (Array.isArray(body.planIds)) {
    const planIds = [...new Set(body.planIds.filter((id): id is string => typeof id === "string"))];
    if (planIds.length) {
      const selected = await Promise.all(planIds.map((id) => store.get<Plan>("plans", id)));
      if (selected.some((plan) => !plan)) return c.json({ error: "One or more selected plans are unavailable." }, 422);
    }
    planBindingChanged = [...(inbound.planIds ?? [])].sort().join(",") !== [...planIds].sort().join(",");
    next.planIds = planIds;
  }
  Object.assign(next, inboundMeta(body));
  if (body.config && typeof body.config === "object" && !Array.isArray(body.config)) next.config = body.config as Record<string, unknown>;
  next.updatedAt = now();
  const bindings = await listAll<InboundNodeBinding>(store, "inbound-node-bindings", `${inbound.id}:`);
  const failures: Array<{ nodeId: string; message: string }> = [];
  for (const binding of bindings) {
    const node = await store.get<NodeRecord>("nodes", binding.nodeId);
    if (!node) continue;
    try { await (await ThreeXuiClient.connect(c.env, node)).updateInbound(binding.panelInboundId, next); }
    catch (error) { failures.push({ nodeId: node.id, message: error instanceof Error ? error.message : "Update failed." }); }
  }
  await store.put("inbounds", next.id, next);
  await store.put("inbound-sync", next.id, { inboundId: next.id, status: failures.length ? "partial" : "synced", failures, updatedAt: now() });
  if (planBindingChanged || inbound.planEnabled !== false || next.planEnabled !== false) {
    const users = await listAll<User>(store, "users");
    await Promise.all(users.filter((user) => user.enabled).map((user) => syncUserEntitlements(store, c.env, user.id)));
  }
  return c.json({ inbound: next, failures, syncStatus: failures.length ? "partial" : "synced" }, { status: failures.length ? 207 : 200 });
});

/**
 * Re-reads the inbound from every bound node so local settings follow panel edits,
 * recreates it on a node that lost it, then provisions the plan clients again.
 */
admin.post("/inbounds/:id/resync", requireAdmin, async (c) => {
  const store = c.get("store");
  const inbound = await store.get<Inbound>("inbounds", c.req.param("id") ?? "");
  if (!inbound) return c.json({ error: "Inbound not found." }, 404);
  const bindings = await listAll<InboundNodeBinding>(store, "inbound-node-bindings", `${inbound.id}:`);
  if (!bindings.length) return c.json({ error: "This inbound is not bound to any node." }, 409);
  const next: Inbound = { ...inbound };
  const failures: Array<{ nodeId: string; message: string }> = [];
  const recreated: string[] = [];
  let refreshed = false;
  for (const binding of bindings) {
    const node = await store.get<NodeRecord>("nodes", binding.nodeId);
    if (!node) { failures.push({ nodeId: binding.nodeId, message: "Node not found." }); continue; }
    try {
      const panel = await ThreeXuiClient.connect(c.env, node);
      const remote = (await panel.listInbounds()).find((item) => item.id === binding.panelInboundId);
      if (!remote) {
        // The panel no longer has it; push the local record back so the node catches up.
        binding.panelInboundId = await panel.addInbound(next);
        await store.put("inbound-node-bindings", binding.id, binding);
        recreated.push(node.id);
        continue;
      }
      const stream = panelObject(remote.streamSettings);
      // Nodes should serve the same inbound, so the first answer becomes the local baseline.
      if (!refreshed) {
        next.port = typeof remote.port === "number" ? remote.port : next.port;
        next.protocol = (remote.protocol ?? next.protocol).toLowerCase();
        next.network = typeof stream.network === "string" ? stream.network : next.network;
        Object.assign(next, panelMeta(remote));
        next.config = { ...inbound.config, settings: panelObject(remote.settings), streamSettings: stream, sniffing: panelObject(remote.sniffing) };
        refreshed = true;
      }
    } catch (error) { failures.push({ nodeId: node.id, message: error instanceof Error ? error.message : "Resync failed." }); }
  }
  if (refreshed) {
    next.updatedAt = now();
    await store.put("inbounds", next.id, next);
  }
  await store.put("inbound-sync", next.id, { inboundId: next.id, status: failures.length ? "partial" : "synced", failures, updatedAt: now() });
  const provisioning: Array<{ userId: string; status: string; errors: Array<{ nodeId: string; message: string }> }> = [];
  if (next.planEnabled !== false) {
    const users = await listAll<User>(store, "users");
    for (const user of users.filter((item) => item.enabled && servesPlan(next, item))) {
      try {
        const result = await syncUserEntitlements(store, c.env, user.id);
        provisioning.push({ userId: user.id, status: result.status, errors: result.errors.slice(0, 5) });
      } catch (error) {
        provisioning.push({ userId: user.id, status: "failed", errors: [{ nodeId: "", message: error instanceof Error ? error.message : "Provisioning failed." }] });
      }
    }
  }
  const syncFailed = failures.length > 0 || provisioning.some((entry) => entry.status !== "synced");
  return c.json({
    inbound: next, refreshed, recreated, failures, provisioning,
    syncStatus: syncFailed ? "partial" : "synced",
  }, { status: syncFailed ? 207 : 200 });
});

admin.delete("/inbounds/:id", requireAdmin, async (c) => {
  const store = c.get("store");
  const id = c.req.param("id") ?? "";
  const inbound = await store.get<Inbound>("inbounds", id);
  if (!inbound) return c.json({ error: "Inbound not found." }, 404);
  const body = await parseBody(c);
  const keepLocal = body?.keepLocal === true;
  const bindings = await listAll<InboundNodeBinding>(store, "inbound-node-bindings", `${id}:`);
  const mappings = (await listAll<ClientMapping>(store, "clients")).filter((mapping) => mapping.inboundId === id);
  const failures: Array<{ nodeId: string; message: string }> = [];
  for (const binding of bindings) {
    const node = await store.get<NodeRecord>("nodes", binding.nodeId);
    if (!node) continue;
    try {
      const panel = await ThreeXuiClient.connect(c.env, node);
      if (inbound.protocol.toLowerCase() !== "wireguard") {
        for (const mapping of mappings) if (mapping.syncedNodes.includes(node.id)) await panel.deleteClient(mapping);
      }
      await panel.deleteInbound(binding.panelInboundId);
    } catch (error) { failures.push({ nodeId: node.id, message: error instanceof Error ? error.message : "Remote delete failed." }); }
  }
  if (failures.length) {
    inbound.enabled = false;
    inbound.updatedAt = now();
    await store.put("inbounds", id, inbound);
    await store.put("inbound-sync", id, { inboundId: id, status: "partial", failures, updatedAt: now() });
    for (const mapping of mappings) { mapping.enable = false; await store.put("clients", mapping.id, mapping); }
    return c.json({ error: "Some nodes did not confirm deletion. The inbound has been disabled locally for retry.", failures }, 207);
  }
  // Take-down mode: the nodes lost the inbound, but the local config and its plan binding stay for a later resync.
  if (keepLocal) {
    inbound.enabled = false;
    inbound.updatedAt = now();
    await store.put("inbounds", id, inbound);
    await store.put("inbound-sync", id, { inboundId: id, status: "detached", failures: [], updatedAt: now() });
    for (const mapping of mappings) { mapping.enable = false; await store.put("clients", mapping.id, mapping); }
    return c.json({ ok: true, detached: true });
  }
  for (const mapping of mappings) await store.delete("clients", mapping.id);
  for (const binding of bindings) await store.delete("inbound-node-bindings", binding.id);
  await store.delete("inbound-sync", id);
  await store.delete("inbounds", id);
  return c.json({ ok: true });
});

admin.get("/orders", requireAdmin, async (c) => {
  const items = await listAll<Order>(c.get("store"), "orders");
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return c.json({ items, count: items.length });
});

admin.delete("/orders/:id", requireAdmin, async (c) => {
  const store = c.get("store");
  const order = await store.get<Order>("orders", c.req.param("id") ?? "");
  if (!order) return c.json({ error: "Order not found." }, 404);
  if (order.status !== "expired" && order.status !== "failed") return c.json({ error: "Only expired or failed orders can be deleted." }, 409);
  await store.delete("orders", order.id);
  return c.json({ ok: true });
});

admin.get("/settings", requireAdmin, async (c) => {
  const settings = await listAll<{ key: string; value: unknown; updatedAt: string }>(c.get("store"), "settings");
  return c.json(publicSettings(Object.fromEntries(settings.map(({ key, value }) => [key, value]))));
});

admin.put("/settings", requireAdmin, async (c) => {
  const body = await parseBody(c);
  if (!body) return c.json({ error: "Settings object is required." }, 400);
  const allowed = new Set([
    ...businessSettingKeys,
    "registrationEnabled", "emailVerificationRequired", "turnstileEnabled", "turnstileOnCheckin", "inviteRequired",
    "userInvitesEnabled", "userInviteLimit", "defaultBalanceMinor", "referralPercent", "referralValidityDays",
    "checkinTrafficBytes", "checkinMinTrafficBytes", "checkinMaxTrafficBytes", "deleteInactiveAfterDays", "deleteWithoutPlanAfterDays", "warnBeforeDeleteDays",
    "notifyTrafficExhausted", "notifySubscriptionExpired", "notifyTrafficReset", "notifyOrderExpired", "notifyReferralReward", "notifyAccountCleanup", "timezone", "planGroups",
  ]);
  for (const [key, value] of Object.entries(body)) {
    if (!allowed.has(key)) continue;
    const configError = validateBusinessSetting(key, value);
    if (configError) return c.json({ error: configError }, 422);
    if (["registrationEnabled", "emailVerificationRequired", "turnstileEnabled", "turnstileOnCheckin", "inviteRequired", "userInvitesEnabled"].includes(key) && typeof value !== "boolean") return c.json({ error: `${key} must be boolean.` }, 422);
    if (key === "referralPercent" && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100)) return c.json({ error: "Referral percent must be between 0 and 100." }, 422);
    if (key === "referralValidityDays" && (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 3650)) return c.json({ error: "Referral validity must be between 0 and 3650 days." }, 422);
    if (["deleteInactiveAfterDays", "deleteWithoutPlanAfterDays", "warnBeforeDeleteDays"].includes(key) && (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 3650)) return c.json({ error: "Account retention days must be between 0 and 3650." }, 422);
    if (["notifyTrafficExhausted", "notifySubscriptionExpired", "notifyTrafficReset", "notifyOrderExpired", "notifyReferralReward", "notifyAccountCleanup"].includes(key) && typeof value !== "boolean") return c.json({ error: "Notification settings must be boolean." }, 422);
    if (key === "userInviteLimit" && (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 1000)) return c.json({ error: "Invite limit is out of range." }, 422);
  }
  const rewardKeys = ["checkinTrafficBytes", "checkinMinTrafficBytes", "checkinMaxTrafficBytes"];
  if (rewardKeys.some((key) => Object.hasOwn(body, key))) {
    if (rewardKeys.some((key) => Object.hasOwn(body, key) && (typeof body[key] !== "number" || !Number.isSafeInteger(body[key]) || (body[key] as number) < 0)) || !(await readCheckinRewardRange(c.get("store"), body))) {
      return c.json({ error: "Check-in rewards must be safe integers with 0 <= minimum <= maximum." }, 422);
    }
  }
  let prepared: Record<string, unknown>;
  try {
    prepared = await prepareBusinessSettings(Object.fromEntries(Object.entries(body).filter(([key]) => allowed.has(key))), c.env);
  } catch {
    return c.json({ error: "Credentials could not be encrypted. Configure APP_ENCRYPTION_KEY with at least 32 characters." }, 422);
  }
  for (const [key, value] of Object.entries(prepared)) await writeSetting(c.get("store"), key, value);
  return c.json({ ok: true });
});

admin.post("/invites", requireAdmin, async (c) => {
  const body = await parseBody(c);
  const count = typeof body?.count === "number" && Number.isInteger(body.count) ? Math.min(Math.max(body.count, 1), 100) : 1;
  const expiresInDays = typeof body?.expiresInDays === "number" && body.expiresInDays > 0 ? Math.min(body.expiresInDays, 365) : null;
  const invites: Invite[] = [];
  for (let index = 0; index < count; index += 1) {
    const code = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
    const invite: Invite = { code, createdBy: c.get("user").id, usedBy: null, usedAt: null, expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 86400000).toISOString() : null, createdAt: now() };
    await c.get("store").put("invites", code, invite);
    invites.push(invite);
  }
  return c.json({ invites }, 201);
});

function planValues(body: Record<string, unknown>): Omit<Plan, "id" | "isDefault" | "createdAt" | "updatedAt"> | null {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const level = Number(body.level);
  const trafficBytes = Number(body.trafficBytes);
  const validityDays = Number(body.validityDays);
  const resetUnit = typeof body.resetUnit === "string" ? body.resetUnit : "month";
  const resetInterval = Number(body.resetInterval ?? 1);
  const resetAtHour = Number(body.resetAtHour ?? 0);
  const resetWeekday = Number(body.resetWeekday ?? 1);
  const resetMonthDay = Number(body.resetMonthDay ?? 1);
  const priceMinor = Number(body.priceMinor);
  if (!name || name.length > 80 || !Number.isInteger(level) || level < 0 || !Number.isSafeInteger(trafficBytes) || trafficBytes < 0 || !Number.isInteger(validityDays) || validityDays < 0 || !resetUnits.has(resetUnit) || !Number.isInteger(resetInterval) || resetInterval < 1 || resetInterval > 365 || !Number.isInteger(resetAtHour) || resetAtHour < 0 || resetAtHour > 23 || !Number.isInteger(resetWeekday) || resetWeekday < 1 || resetWeekday > 7 || !Number.isInteger(resetMonthDay) || resetMonthDay < 1 || resetMonthDay > 31 || !Number.isSafeInteger(priceMinor) || priceMinor < 0) return null;
  return {
    name, description: typeof body.description === "string" ? body.description.slice(0, 500) : "", group: typeof body.group === "string" ? body.group.slice(0, 80) : "default",
    level, trafficBytes, validityDays, resetUnit: resetUnit as Plan["resetUnit"], resetInterval, resetAtHour, resetWeekday, resetMonthDay,
    priceMinor, currency: typeof body.currency === "string" ? body.currency.toUpperCase().slice(0, 3) : "USD",
    allowPaidUpgrade: body.allowPaidUpgrade === true,
    ...(typeof body.dodoProductId === "string" && body.dodoProductId.trim() ? { dodoProductId: body.dodoProductId.trim().slice(0, 120) } : {}),
    enabled: body.enabled !== false,
    hidden: body.hidden === true,
  };
}

export default admin;
