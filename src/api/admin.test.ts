import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { sign as signRsa, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import type { Inbound, Order, Plan, User } from "../domain/types";
import type { RuntimeEnv } from "../env";
import { createCheckout, expirePendingOrders, settleFailedOrder, settlePaidOrder } from "../services/billing";
import { runLifecycleMaintenance } from "../services/lifecycle";
import { createUserNotification } from "../services/notifications";
import { ThreeXuiClient, inboundPayload } from "../adapters/xui/client";
import { D1Store } from "../storage/d1";
import worker from "../worker";

const require = createRequire(import.meta.url);
const { createD1TestPlatform } = require("../storage/d1-test-platform.cjs") as {
  createD1TestPlatform: (configPath: string) => Promise<{ env: { DB: D1Database }; dispose: () => Promise<void> }>;
};

const bootstrapToken = "local-admin-bootstrap-test-token";
let platform: Awaited<ReturnType<typeof createD1TestPlatform>>;
let env: RuntimeEnv;
let cookie: string;

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return worker.fetch(new Request(`https://manager.test${path}`, init), env, {} as ExecutionContext);
}

function signPayload(payload: string, privateKey: string): string {
  return signRsa("RSA-SHA256", Buffer.from(payload), privateKey).toString("base64");
}

describe("admin API local D1 integration", () => {
  beforeAll(async () => {
    platform = await createD1TestPlatform(fileURLToPath(new URL("../../wrangler.jsonc", import.meta.url)));
    const database = platform.env.DB;
    for (const migrationUrl of ["../../migrations/0001_init.sql", "../../migrations/0002_usage_event_apply_state.sql", "../../migrations/0003_atomic_traffic_samples.sql"]) {
      const sql = await readFile(new URL(migrationUrl, import.meta.url), "utf8");
      const statements = sql.split(";").map((statement) => statement.trim()).filter((statement) => statement && !statement.startsWith("PRAGMA "));
      await database.batch(statements.map((statement) => database.prepare(statement)));
    }
    env = {
      ...platform.env,
      STORAGE_DRIVER: "d1",
      ADMIN_BOOTSTRAP_TOKEN: bootstrapToken,
      APP_ENCRYPTION_KEY: "local-test-encryption-key-32-bytes",
    } as RuntimeEnv;

    const response = await request("/api/auth/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Bootstrap-Token": bootstrapToken, Origin: "https://manager.test" },
      body: JSON.stringify({ email: "admin@example.test", password: "local-test-admin-password" }),
    });
    if (response.status !== 201) throw new Error(`Local admin bootstrap failed with ${response.status}: ${await response.text()}`);
    cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    if (!cookie) throw new Error("Local admin bootstrap did not issue a session cookie.");
  });

  afterAll(async () => {
    await platform?.dispose();
  });

  it("loads admin dashboard collections and creates then updates a plan", async () => {
    const headers = { Cookie: cookie, Origin: "https://manager.test" };
    const paths = ["dashboard", "users", "plans", "nodes", "inbounds", "orders"];
    const responses = await Promise.all(paths.map((path) => request(`/api/admin/${path}`, { headers })));
    expect(responses.map((response) => response.status)).toEqual(paths.map(() => 200));

    const create = await request("/api/admin/plans", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Premium", description: "Local integration plan", level: 2, trafficBytes: 10_000_000_000,
        validityDays: 30, priceMinor: 1000, currency: "USD", resetUnit: "month", resetInterval: 1,
        resetAtHour: 0, resetWeekday: 1, resetMonthDay: 1, allowPaidUpgrade: true, enabled: true,
      }),
    });
    expect(create.status).toBe(201);
    const { plan } = await create.json() as { plan: { id: string; enabled: boolean } };
    expect(plan.enabled).toBe(true);

    const update = await request(`/api/admin/plans/${plan.id}`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({ plan: { id: plan.id, enabled: false } });
  });

  it("lets an administrator create a verified user who can sign in immediately", async () => {
    const headers = { Cookie: cookie, Origin: "https://manager.test", "Content-Type": "application/json" };
    const email = `admin-created-${crypto.randomUUID()}@example.test`;
    const password = "Admin-Created-Password-2026";
    const store = new D1Store(platform.env.DB as unknown as Env["DB"]);
    try {
      const create = await request("/api/admin/users", {
        method: "POST",
        headers,
        body: JSON.stringify({ email, password, role: "user", enabled: true }),
      });
      expect(create.status).toBe(201);
      const created = await create.json() as { user: { id: string; email: string; emailVerifiedAt: string | null } };
      expect(created.user).toMatchObject({ email, emailVerifiedAt: expect.any(String) });

      const login = await request("/api/auth/login", { method: "POST", headers, body: JSON.stringify({ email, password }) });
      expect(login.status).toBe(200);

      const duplicate = await request("/api/admin/users", {
        method: "POST",
        headers,
        body: JSON.stringify({ email, password, role: "user" }),
      });
      expect(duplicate.status).toBe(409);

      const shortPassword = await request("/api/admin/users", {
        method: "POST",
        headers,
        body: JSON.stringify({ email: `short-${email}`, password: "short", role: "user" }),
      });
      expect(shortPassword.status).toBe(422);
    } finally {
      const index = await store.get<{ userId: string }>("user-email", email);
      if (index) await store.delete("users", index.userId);
      await store.delete("user-email", email);
      await store.delete("user-email", `short-${email}`);
    }
  });

  it("credits and refunds an account balance through manual orders", async () => {
    const headers = { Cookie: cookie, Origin: "https://manager.test", "Content-Type": "application/json" };
    const store = new D1Store(platform.env.DB as unknown as Env["DB"]);
    const email = `manual-balance-${crypto.randomUUID()}@example.test`;
    let userId = "";
    try {
      const create = await request("/api/admin/users", {
        method: "POST", headers,
        body: JSON.stringify({ email, password: "Manual-Balance-Password-2026", role: "user", enabled: true }),
      });
      expect(create.status).toBe(201);
      const created = await create.json() as { user: { id: string; balanceMinor: number } };
      userId = created.user.id;
      expect(created.user.balanceMinor).toBe(0);
      const path = `/api/admin/users/${userId}/balance`;

      const credit = await request(path, {
        method: "POST", headers,
        body: JSON.stringify({ action: "credit", amountMinor: 2500, currency: "usd", note: "Support goodwill" }),
      });
      expect(credit.status).toBe(201);
      const credited = await credit.json() as { user: { balanceMinor: number }; order: Order };
      expect(credited.user.balanceMinor).toBe(2500);
      expect(credited.order).toMatchObject({
        type: "topup", provider: "manual", status: "paid", amountMinor: 2500, currency: "USD",
        metadata: { kind: "manual_credit", note: "Support goodwill" },
      });
      expect(credited.order.paidAt).toEqual(expect.any(String));

      const refund = await request(path, {
        method: "POST", headers,
        body: JSON.stringify({ action: "refund", amountMinor: 1000, currency: "USD" }),
      });
      expect(refund.status).toBe(201);
      const refunded = await refund.json() as { user: { balanceMinor: number }; order: Order };
      expect(refunded.user.balanceMinor).toBe(1500);
      expect(refunded.order).toMatchObject({ status: "refunded", amountMinor: 1000, metadata: { kind: "manual_refund" } });

      const overdraft = await request(path, {
        method: "POST", headers,
        body: JSON.stringify({ action: "refund", amountMinor: 2000, currency: "USD" }),
      });
      expect(overdraft.status).toBe(409);
      expect((await store.get<User>("users", userId))?.balanceMinor).toBe(1500);
      const orders = await store.list<Order>("orders");
      expect(orders.items.filter((order) => order.userId === userId)).toHaveLength(2);
      expect((await store.list<{ id: string }>("ledger-entries")).items
        .filter((entry) => entry.id === `manual-credit:${credited.order.id}` || entry.id === `manual-refund:${refunded.order.id}`)).toHaveLength(2);

      const zero = await request(path, { method: "POST", headers, body: JSON.stringify({ action: "credit", amountMinor: 0, currency: "USD" }) });
      expect(zero.status).toBe(422);
      const badCurrency = await request(path, { method: "POST", headers, body: JSON.stringify({ action: "credit", amountMinor: 100, currency: "US" }) });
      expect(badCurrency.status).toBe(422);
      const unknownAction = await request(path, { method: "POST", headers, body: JSON.stringify({ action: "gift", amountMinor: 100, currency: "USD" }) });
      expect(unknownAction.status).toBe(422);
      const missingUser = await request(`/api/admin/users/${crypto.randomUUID()}/balance`, { method: "POST", headers, body: JSON.stringify({ action: "credit", amountMinor: 100, currency: "USD" }) });
      expect(missingUser.status).toBe(404);
      const crossOrigin = await request(path, {
        method: "POST", headers: { Cookie: cookie, Origin: "https://evil.test", "Content-Type": "application/json" },
        body: JSON.stringify({ action: "credit", amountMinor: 100, currency: "USD" }),
      });
      expect(crossOrigin.status).toBe(403);
    } finally {
      for (const order of (await store.list<Order>("orders")).items.filter((item) => item.userId === userId)) await store.delete("orders", order.id);
      for (const entry of (await store.list<{ id: string }>("ledger-entries")).items.filter((item) => item.id.startsWith("manual-"))) await store.delete("ledger-entries", entry.id);
      if (userId) await store.delete("users", userId);
      await store.delete("user-email", email);
    }
  });

  it("applies one configured check-in reward per day with D1 atomic state", async () => {
    const headers = { Cookie: cookie, Origin: "https://manager.test", "Content-Type": "application/json" };
    const store = new D1Store(platform.env.DB as unknown as Env["DB"]);
    const user = (await store.list<User>("users")).items[0];
    expect(user).toBeTruthy();
    const oldState = {
      planTrafficBytes: user!.planTrafficBytes, checkinStreak: user!.checkinStreak,
      lastCheckinAt: user!.lastCheckinAt, updatedAt: user!.updatedAt,
    };
    const now = new Date().toISOString();
    await store.put("settings", "turnstileOnCheckin", { key: "turnstileOnCheckin", value: false, updatedAt: now });
    await store.put("settings", "checkinTrafficBytes", { key: "checkinTrafficBytes", value: 200 * 1024 * 1024, updatedAt: now });
    try {
      const response = await request("/api/user/checkin", { method: "POST", headers, body: "{}" });
      expect(response.status).toBe(200);
      const result = await response.json() as { rewardBytes: number; checkinStreak: number; planTrafficBytes: number; syncStatus: string };
      expect(result).toMatchObject({ rewardBytes: 200 * 1024 * 1024, checkinStreak: 1, planTrafficBytes: oldState.planTrafficBytes + 200 * 1024 * 1024 });
      expect(result.syncStatus).toBe("synced");

      const duplicate = await request("/api/user/checkin", { method: "POST", headers, body: "{}" });
      expect(duplicate.status).toBe(409);
      const stored = await store.get<User>("users", user!.id);
      expect(stored).toMatchObject({
        planTrafficBytes: oldState.planTrafficBytes + 200 * 1024 * 1024,
        checkinStreak: 1,
        lastCheckinAt: expect.any(String),
      });
    } finally {
      await store.patchUser(user!.id, oldState);
    }
  });

  it("wires public Turnstile settings and validates action and hostname for registration and check-in", async () => {
    const headers = { Cookie: cookie, Origin: "https://manager.test", "Content-Type": "application/json" };
    const store = new D1Store(platform.env.DB as unknown as Env["DB"]);
    const user = (await store.list<User>("users")).items[0];
    expect(user).toBeTruthy();
    const oldUserState = {
      planTrafficBytes: user!.planTrafficBytes, checkinStreak: user!.checkinStreak,
      lastCheckinAt: user!.lastCheckinAt, updatedAt: user!.updatedAt,
    };
    const settingKeys = ["turnstileEnabled", "turnstileOnCheckin", "emailVerificationRequired", "checkinTrafficBytes"];
    const oldSettings = new Map<string, unknown | null>();
    for (const key of settingKeys) oldSettings.set(key, await store.get("settings", key));
    const previousEnv = env;
    const email = `turnstile-${crypto.randomUUID()}@example.test`;
    const verificationResults = [
      { success: true, action: "checkin", hostname: "manager.test" },
      { success: true, action: "signup", hostname: "manager.test" },
      { success: true, action: "checkin", hostname: "wrong.example.test" },
      { success: true, action: "checkin", hostname: "manager.test" },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
      const form = init?.body as FormData;
      expect(form.get("secret")).toBe("local-turnstile-secret");
      expect(form.get("response")).toBeTruthy();
      return new Response(JSON.stringify(verificationResults.shift()), { status: 200 });
    });
    env = { ...env, TURNSTILE_SITE_KEY: "local-turnstile-site-key", TURNSTILE_SECRET_KEY: "local-turnstile-secret" } as RuntimeEnv;
    vi.stubGlobal("fetch", fetchMock);
    try {
      const now = new Date().toISOString();
      await store.put("settings", "turnstileEnabled", { key: "turnstileEnabled", value: true, updatedAt: now });
      await store.put("settings", "turnstileOnCheckin", { key: "turnstileOnCheckin", value: true, updatedAt: now });
      await store.put("settings", "emailVerificationRequired", { key: "emailVerificationRequired", value: false, updatedAt: now });
      await store.put("settings", "checkinTrafficBytes", { key: "checkinTrafficBytes", value: 1024, updatedAt: now });

      const config = await request("/api/auth/config");
      expect(config.status).toBe(200);
      const publicConfig = await config.json();
      expect(publicConfig).toEqual({ turnstileSiteKey: "local-turnstile-site-key", registrationTurnstileEnabled: true, checkinTurnstileEnabled: true });
      expect(JSON.stringify(publicConfig)).not.toContain("local-turnstile-secret");

      const registrationBody = { email, password: "local-turnstile-password-12", turnstileToken: "signup-token" };
      const invalidAction = await request("/api/auth/register", { method: "POST", headers, body: JSON.stringify(registrationBody) });
      expect(invalidAction.status).toBe(422);
      verificationResults[0] = { success: true, action: "signup", hostname: "manager.test" };
      const registration = await request("/api/auth/register", { method: "POST", headers, body: JSON.stringify(registrationBody) });
      expect(registration.status).toBe(201);

      const missingToken = await request("/api/user/checkin", { method: "POST", headers, body: "{}" });
      expect(missingToken.status).toBe(422);
      const wrongHost = await request("/api/user/checkin", { method: "POST", headers, body: JSON.stringify({ turnstileToken: "wrong-host-token" }) });
      expect(wrongHost.status).toBe(422);
      const checkin = await request("/api/user/checkin", { method: "POST", headers, body: JSON.stringify({ turnstileToken: "checkin-token" }) });
      expect(checkin.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(await store.get<User>("users", user!.id)).toMatchObject({ planTrafficBytes: oldUserState.planTrafficBytes + 1024 });
    } finally {
      vi.unstubAllGlobals();
      env = previousEnv;
      await store.patchUser(user!.id, oldUserState);
      const registered = await store.get<{ userId: string }>("user-email", email);
      if (registered) {
        const sessions = await store.list<{ id: string; userId: string }>("sessions");
        for (const session of sessions.items.filter((item) => item.userId === registered.userId)) await store.delete("sessions", session.id);
        await store.delete("user-email", email);
        await store.delete("users", registered.userId);
      }
      for (const [key, value] of oldSettings) {
        if (value === null) await store.delete("settings", key);
        else await store.put("settings", key, value);
      }
    }
  });

  it("serves user dashboard collections from D1 without exposing encrypted credentials", async () => {
    const headers = { Cookie: cookie, Origin: "https://manager.test" };
    const store = new D1Store(platform.env.DB as unknown as Env["DB"]);
    const currentUser = (await store.list<User>("users")).items[0];
    expect(currentUser).toBeTruthy();
    const userId = currentUser!.id;
    const now = new Date().toISOString();
    const usageDay = now.slice(0, 10);
    const plan: Plan = {
      id: `dplan-${crypto.randomUUID()}`, name: "Dashboard test plan", description: "Local API fixture", group: "test",
      level: 1, trafficBytes: 5_000_000_000, validityDays: 30, resetUnit: "month", resetInterval: 1,
      resetAtHour: 0, resetWeekday: 1, resetMonthDay: 1, priceMinor: 500, currency: "USD",
      allowPaidUpgrade: false, isDefault: false, enabled: true, createdAt: now, updatedAt: now,
    };
    const nodeId = `dnode-${crypto.randomUUID()}`;
    const inboundId = `din-${crypto.randomUUID()}`;
    const clientSecret = "dashboard-encrypted-client-secret-fixture";
    const order: Order = {
      id: `dord-${crypto.randomUUID()}`, userId, planId: plan.id, type: "subscription", amountMinor: 500,
      currency: "USD", provider: "waffo", providerOrderId: null, checkoutUrl: null, status: "paid",
      expiresAt: now, paidAt: now, createdAt: now, updatedAt: now,
    };
    const usageId = `${userId}:${usageDay}`;
    const previousUsage = await store.get("daily-usage", usageId);
    try {
      await store.put("plans", plan.id, plan);
      await store.patchUser(userId, {
        planId: plan.id, planLevel: plan.level, planTrafficBytes: plan.trafficBytes, billedBytes: 125_000,
        planStartedAt: now, planExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString(), balanceMinor: 75,
      });
      await store.put("nodes", nodeId, {
        id: nodeId, name: "Dashboard fixture node", region: "local", panelUrl: "https://panel.example.test",
        publicAddress: "node.example.test", username: "fixture-user", encryptedPassword: "encrypted-panel-credential",
        apiTokenEncrypted: null, basePath: "/", status: "online", supportedApi: true, lastCheckedAt: now,
        inboundCount: 1, syncStatus: "synced", lastSyncAt: now, lastError: null, enabled: true, createdAt: now, updatedAt: now,
      });
      await store.put("inbounds", inboundId, {
        id: inboundId, name: "Dashboard fixture inbound", protocol: "vless", network: "tcp", port: 443,
        minimumLevel: 0, multiplier: 1, enabled: true, config: {}, createdAt: now, updatedAt: now,
      });
      await store.put("inbound-node-bindings", `${inboundId}:${nodeId}`, {
        id: `${inboundId}:${nodeId}`, inboundId, nodeId, panelInboundId: 44, createdAt: now,
      });
      await store.put("clients", `${userId}:${inboundId}`, {
        id: `${userId}:${inboundId}`, userId, inboundId, email: "dashboard@example.test", clientId: "local-client-id",
        encryptedSecret: clientSecret, flow: "", enable: true, syncStatus: "synced", syncError: null,
        syncedNodes: [nodeId], createdAt: now, updatedAt: now,
      });
      await store.put("daily-usage", usageId, { userId, usageDay, rawBytes: 100_000, billedBytes: 125_000 });
      await store.put("orders", order.id, order);

      const paths = ["overview", "plans", "nodes", "orders", "subscription", "usage?days=1"];
      const responses = await Promise.all(paths.map((path) => request(`/api/user/${path}`, { headers })));
      expect(responses.map((response) => response.status)).toEqual(paths.map(() => 200));
      const [overview, plans, nodes, orders, subscription, usage] = await Promise.all(responses.map((response) => response.json())) as [
        { user: Record<string, unknown>; plan: Plan; balanceMinor: number; capabilities: Record<string, boolean>; nodes: Array<{ id: string }>; clients: Array<Record<string, unknown>> },
        { items: Plan[] },
        { items: Array<{ node: { id: string }; client: { clientId: string } | null }> },
        { items: Order[] },
        { plan: Plan; clients: Array<{ inboundName: string }>; capabilities: Record<string, boolean> },
        { items: Array<{ usageDay: string; billedBytes: number }>; totalBilledBytes: number; meteringEnabled: boolean },
      ];
      expect(overview.user).toMatchObject({ id: userId, balanceMinor: 75 });
      expect(overview.user).not.toHaveProperty("passwordHash");
      expect(overview.plan.id).toBe(plan.id);
      expect(overview.capabilities).toEqual({ trafficMetering: true, quotaEnforcement: true, atomicPaymentSettlement: true });
      expect(overview.nodes).toContainEqual(expect.objectContaining({ id: nodeId }));
      expect(overview.clients[0]).not.toHaveProperty("encryptedSecret");
      expect(JSON.stringify(overview)).not.toContain(clientSecret);
      expect(plans.items).toContainEqual(expect.objectContaining({ id: plan.id }));
      expect(nodes.items).toContainEqual(expect.objectContaining({
        node: expect.objectContaining({ id: nodeId }),
        client: expect.objectContaining({ clientId: "local-client-id" }),
      }));
      expect(orders.items).toContainEqual(expect.objectContaining({ id: order.id }));
      expect(subscription).toMatchObject({ plan: { id: plan.id }, clients: [{ inboundName: "Dashboard fixture inbound" }], capabilities: overview.capabilities });
      expect(usage).toMatchObject({ items: [{ usageDay, billedBytes: 125_000 }], totalBilledBytes: 125_000, meteringEnabled: true });
    } finally {
      await store.put("users", userId, currentUser!);
      await store.delete("orders", order.id);
      await store.delete("daily-usage", usageId);
      if (previousUsage !== null) await store.put("daily-usage", usageId, previousUsage);
      await store.delete("clients", `${userId}:${inboundId}`);
      await store.delete("inbound-node-bindings", `${inboundId}:${nodeId}`);
      await store.delete("inbounds", inboundId);
      await store.delete("nodes", nodeId);
      await store.delete("plans", plan.id);
    }
  });

  it("creates a node and inbound through an isolated 3X-UI adapter mock", async () => {
    const headers = { Cookie: cookie, Origin: "https://manager.test", "Content-Type": "application/json" };
    const store = new D1Store(platform.env.DB as unknown as Env["DB"]);
    const nodeName = `Mock panel node ${crypto.randomUUID()}`;
    const inboundName = `Mock inbound ${crypto.randomUUID()}`;
    const panel = {
      listInbounds: vi.fn(async () => []),
      supportsClientApi: vi.fn(async () => true),
      addInbound: vi.fn(async () => 42),
      updateInbound: vi.fn(async () => undefined),
    };
    const connect = vi.spyOn(ThreeXuiClient, "connect").mockResolvedValue(panel as unknown as ThreeXuiClient);

    try {
      const nodeResponse = await request("/api/admin/nodes", {
        method: "POST", headers,
        body: JSON.stringify({
          name: nodeName, region: "local", panelUrl: "https://panel.example.test", publicAddress: "node.example.test",
          username: "local-user", password: "local-panel-password", basePath: "/", enabled: true,
        }),
      });
      expect(nodeResponse.status).toBe(201);
      const { node, probe } = await nodeResponse.json() as { node: { id: string; encryptedPassword?: string; apiTokenEncrypted?: string }; probe: { status: string } };
      expect(probe.status).toBe("online");
      expect(node).not.toHaveProperty("encryptedPassword");
      expect(node).not.toHaveProperty("apiTokenEncrypted");

      const inboundResponse = await request("/api/admin/inbounds", {
        method: "POST", headers,
        body: JSON.stringify({
          name: inboundName, protocol: "vless", network: "tcp", port: 443, nodeIds: [node.id],
          listen: "0.0.0.0", total: 5_000_000_000, expiryTime: 1_800_000_000_000, trafficReset: "weekly",
          trafficResetDay: 3, tag: "mock-tag", shareAddrStrategy: "listen", subSortIndex: 7,
          excludeFromSub: true, disableFlow: true, defaultFlow: "xtls-rprx-vision",
          config: { settings: { clients: [], decryption: "none" }, streamSettings: { network: "tcp", security: "none" }, sniffing: { enabled: true }, nodeId: 9 },
        }),
      });
      const inboundResult = await inboundResponse.json() as { inbound?: { id: string } & Record<string, unknown>; bindings: Array<{ inboundId: string; nodeId: string; panelInboundId: number }>; syncStatus: string };
      expect(inboundResponse.status).toBe(201);
      expect(inboundResult.syncStatus).toBe("synced");
      expect(inboundResult.bindings).toEqual([{ id: `${inboundResult.inbound!.id}:${node.id}`, inboundId: inboundResult.inbound!.id, nodeId: node.id, panelInboundId: 42, createdAt: expect.any(String) }]);
      expect(inboundResult.inbound).toMatchObject({
        listen: "0.0.0.0", total: 5_000_000_000, expiryTime: 1_800_000_000_000, trafficReset: "weekly", trafficResetDay: 3,
        tag: "mock-tag", shareAddrStrategy: "listen", subSortIndex: 7, excludeFromSub: true, disableFlow: true, defaultFlow: "xtls-rprx-vision",
      });
      expect(inboundPayload(inboundResult.inbound as unknown as Inbound)).toMatchObject({
        remark: inboundName, total: 5_000_000_000, listen: "0.0.0.0", expiryTime: 1_800_000_000_000, trafficReset: "weekly",
        trafficResetDay: 3, tag: "mock-tag", shareAddrStrategy: "listen", subSortIndex: 7, excludeFromSub: true, disableFlow: true,
        nodeId: 9, settings: { clients: [], decryption: "none" },
      });
      expect(panel.addInbound).toHaveBeenCalledTimes(1);
      expect(connect).toHaveBeenCalledTimes(2);

      const patchResponse = await request(`/api/admin/inbounds/${inboundResult.inbound!.id}`, {
        method: "PATCH", headers,
        body: JSON.stringify({ trafficReset: "monthly", trafficResetDay: 9, tag: "", subSortIndex: 2 }),
      });
      expect(patchResponse.status).toBe(200);
      expect(await patchResponse.json()).toMatchObject({ inbound: { trafficReset: "monthly", trafficResetDay: 9, tag: "", subSortIndex: 2 } });
    } finally {
      connect.mockRestore();
      const inbounds = await store.list<{ id: string; name: string }>("inbounds");
      const inbound = inbounds.items.find((item) => item.name === inboundName);
      if (inbound) {
        const clients = await store.list<{ id: string; inboundId: string }>("clients");
        for (const client of clients.items.filter((item) => item.inboundId === inbound.id)) await store.delete("clients", client.id);
        const bindings = await store.list<{ id: string; inboundId: string }>("inbound-node-bindings");
        for (const binding of bindings.items.filter((item) => item.inboundId === inbound.id)) await store.delete("inbound-node-bindings", binding.id);
        await store.delete("inbound-sync", inbound.id);
        await store.delete("inbounds", inbound.id);
      }
      const nodes = await store.list<{ id: string; name: string }>("nodes");
      const node = nodes.items.find((item) => item.name === nodeName);
      if (node) await store.delete("nodes", node.id);
    }
  });

  it("imports panel inbounds for one node without provisioning plan clients", async () => {
    const headers = { Cookie: cookie, Origin: "https://manager.test", "Content-Type": "application/json" };
    const store = new D1Store(platform.env.DB as unknown as Env["DB"]);
    const nodeName = `Import panel node ${crypto.randomUUID()}`;
    const remoteInbounds = [
      {
        id: 101, remark: "Tokyo VLESS", protocol: "vless", port: 443, enable: true,
        listen: "0.0.0.0", total: 1_000_000_000, expiryTime: 1_800_000_000_000, trafficReset: "monthly", trafficResetDay: 5,
        tag: "tokyo", shareAddrStrategy: "custom", shareAddr: "edge.example.test", subSortIndex: 3, excludeFromSub: true, disableFlow: false,
        settings: JSON.stringify({ clients: [{ email: "manual@client", id: "b831381d-6324-4d53-ad4f-8cda48b30811" }], decryption: "none" }),
        streamSettings: JSON.stringify({ network: "ws", security: "tls", wsSettings: { path: "/ray" } }),
        sniffing: JSON.stringify({ enabled: true, destOverride: ["http", "tls"] }),
      },
      { id: 102, remark: "", protocol: "trojan", port: 8443, enable: false, settings: "{}", streamSettings: "{}", sniffing: "{}" },
    ];
    const panel = {
      listInbounds: vi.fn(async () => remoteInbounds),
      supportsClientApi: vi.fn(async () => true),
      addInbound: vi.fn(async () => 0),
      updateInbound: vi.fn(async () => undefined),
      upsertClient: vi.fn(async () => undefined),
    };
    const connect = vi.spyOn(ThreeXuiClient, "connect").mockResolvedValue(panel as unknown as ThreeXuiClient);
    let nodeId = "";

    try {
      const nodeResponse = await request("/api/admin/nodes", {
        method: "POST", headers,
        body: JSON.stringify({
          name: nodeName, region: "local", panelUrl: "https://panel.example.test", publicAddress: "node.example.test",
          username: "local-user", password: "local-panel-password", basePath: "/", enabled: true,
        }),
      });
      expect(nodeResponse.status).toBe(201);
      nodeId = ((await nodeResponse.json()) as { node: { id: string } }).node.id;

      const remoteResponse = await request(`/api/admin/inbounds/remote?nodeId=${nodeId}`, { headers });
      expect(remoteResponse.status).toBe(200);
      const remote = await remoteResponse.json() as { items: Array<Record<string, unknown>>; count: number };
      expect(remote.count).toBe(2);
      expect(remote.items[0]).toMatchObject({ panelInboundId: 101, name: "Tokyo VLESS", network: "ws", security: "tls", imported: false });
      expect(remote.items[1]).toMatchObject({ panelInboundId: 102, name: "Inbound 102", protocol: "trojan", enabled: false });

      const clientsBefore = (await store.list("clients")).items.length;
      const importResponse = await request("/api/admin/inbounds/import", {
        method: "POST", headers,
        body: JSON.stringify({ nodeId, panelInboundIds: [101, 101, 999] }),
      });
      expect(importResponse.status).toBe(200);
      const imported = await importResponse.json() as {
        items: Array<{ id: string; name: string; network: string; port: number; minimumLevel: number; planEnabled: boolean; enabled: boolean; config: Record<string, unknown> }>;
        bindings: Array<{ inboundId: string; nodeId: string; panelInboundId: number }>;
        skipped: number[];
        imported: number;
      };
      expect(imported.imported).toBe(1);
      expect(imported.skipped).toEqual([999]);
      expect(imported.items[0]).toMatchObject({
        name: "Tokyo VLESS", network: "ws", port: 443, minimumLevel: 0, planEnabled: false, enabled: true,
        listen: "0.0.0.0", total: 1_000_000_000, expiryTime: 1_800_000_000_000, trafficReset: "monthly", trafficResetDay: 5,
        tag: "tokyo", shareAddrStrategy: "custom", shareAddr: "edge.example.test", subSortIndex: 3, excludeFromSub: true, disableFlow: false,
      });
      expect(imported.items[0].config).toEqual({
        settings: { clients: [{ email: "manual@client", id: "b831381d-6324-4d53-ad4f-8cda48b30811" }], decryption: "none" },
        streamSettings: { network: "ws", security: "tls", wsSettings: { path: "/ray" } },
        sniffing: { enabled: true, destOverride: ["http", "tls"] },
      });
      expect(imported.bindings).toEqual([{ id: `${imported.items[0].id}:${nodeId}`, inboundId: imported.items[0].id, nodeId, panelInboundId: 101, createdAt: expect.any(String) }]);
      expect(panel.addInbound).not.toHaveBeenCalled();
      expect(panel.upsertClient).not.toHaveBeenCalled();
      expect((await store.list("clients")).items.length).toBe(clientsBefore);

      const listedRemote = await (await request(`/api/admin/inbounds/remote?nodeId=${nodeId}`, { headers })).json() as { items: Array<{ panelInboundId: number; imported: boolean }> };
      expect(listedRemote.items.find((item) => item.panelInboundId === 101)?.imported).toBe(true);

      const again = await request("/api/admin/inbounds/import", {
        method: "POST", headers, body: JSON.stringify({ nodeId, panelInboundIds: [101] }),
      });
      expect(again.status).toBe(200);
      expect((await again.json() as { imported: number; skipped: number[] })).toMatchObject({ imported: 0, skipped: [101] });

      const enableResponse = await request(`/api/admin/inbounds/${imported.items[0].id}`, {
        method: "PATCH", headers, body: JSON.stringify({ planEnabled: true }),
      });
      expect(enableResponse.status).toBe(200);
      expect((await enableResponse.json() as { inbound: { planEnabled: boolean }; syncStatus: string })).toMatchObject({
        inbound: { planEnabled: true }, syncStatus: "synced",
      });
      expect(panel.updateInbound).toHaveBeenCalledWith(101, expect.objectContaining({ planEnabled: true, name: "Tokyo VLESS" }));
    } finally {
      connect.mockRestore();
      if (nodeId) {
        const bindings = await store.list<{ id: string; nodeId: string }>("inbound-node-bindings");
        for (const binding of bindings.items.filter((item) => item.nodeId === nodeId)) await store.delete("inbound-node-bindings", binding.id);
        const inbounds = await store.list<{ id: string; name: string }>("inbounds");
        for (const inbound of inbounds.items.filter((item) => item.name === "Tokyo VLESS")) {
          await store.delete("inbound-sync", inbound.id);
          await store.delete("inbounds", inbound.id);
        }
      }
      const nodes = await store.list<{ id: string; name: string }>("nodes");
      for (const node of nodes.items.filter((item) => item.name === nodeName)) await store.delete("nodes", node.id);
    }
  });

  it("serializes an admin user edit with the payment settlement lease", async () => {    const headers = { Cookie: cookie, Origin: "https://manager.test", "Content-Type": "application/json" };
    const users = await (await request("/api/admin/users", { headers })).json() as { items: User[] };
    const user = users.items[0];
    expect(user).toBeTruthy();
    const store = new D1Store(platform.env.DB as unknown as Env["DB"]);
    const lockName = `payment-user:${user.id}`;
    const owner = crypto.randomUUID();
    expect(await store.acquireLease(lockName, owner, Date.now() + 60_000)).toBe(true);
    let response: Response;
    try {
      const checkout = await request("/api/payments/checkout", {
        method: "POST", headers, body: JSON.stringify({ type: "topup", provider: "waffo", amountMinor: 100, currency: "USD" }),
      });
      expect(checkout.status).toBe(409);
      response = await request(`/api/admin/users/${user.id}`, {
        method: "PATCH", headers, body: JSON.stringify({ planExpiresAt: null }),
      });
    } finally {
      await store.releaseLease(lockName, owner);
    }
    expect(response.status).toBe(409);

    const retried = await request(`/api/admin/users/${user.id}`, {
      method: "PATCH", headers, body: JSON.stringify({ planExpiresAt: null }),
    });
    expect(retried.status).toBe(200);
  });

  it("recalculates paid-upgrade credit from the latest D1 user state", async () => {
    const store = new D1Store(platform.env.DB as unknown as Env["DB"]);
    const users = await (await request("/api/admin/users", { headers: { Cookie: cookie, Origin: "https://manager.test" } })).json() as { items: User[] };
    const user = await store.get<User>("users", users.items[0].id);
    expect(user).toBeTruthy();
    const makePlan = (id: string, level: number, allowPaidUpgrade: boolean): Plan => ({
      id, name: id, description: "", group: "default", level, trafficBytes: 1000, validityDays: 30,
      resetUnit: "month", resetInterval: 1, resetAtHour: 0, resetWeekday: 1, resetMonthDay: 1,
      priceMinor: 1000, currency: "USD", allowPaidUpgrade, isDefault: false, enabled: true,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    await store.put("plans", "current-plan", makePlan("current-plan", 1, true));
    await store.put("plans", "next-plan", makePlan("next-plan", 2, true));
    const expiresAt = new Date(Date.now() + 30 * 86400000).toISOString();
    await store.patchUser(user!.id, {
      planId: "current-plan", planLevel: 1, planTrafficBytes: 1000, billedBytes: 0,
      planStartedAt: new Date().toISOString(), planExpiresAt: expiresAt,
    });
    const staleUser = await store.get<User>("users", user!.id);
    await store.patchUser(user!.id, { billedBytes: 1000 });

    await expect(createCheckout(store, env, staleUser!, {
      type: "upgrade", provider: "waffo", planId: "next-plan",
    })).rejects.toThrow("Waffo requires WAFFO_API_KEY");

    const orders = await store.list<{ amountMinor: number; metadata: { creditMinor: number }; planId: string; type: string }>("orders");
    expect(orders.items).toContainEqual(expect.objectContaining({
      amountMinor: 1000, planId: "next-plan", type: "upgrade",
      metadata: expect.objectContaining({ creditMinor: 0 }),
    }));
  });

  it("reconciles a late success against Waffo inquiry after a close event", async () => {
    const keys = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const previousEnv = env;
    env = {
      ...env, WAFFO_API_KEY: "local-waffo-test-key", WAFFO_SIGNING_KEY: keys.privateKey,
      WAFFO_PUBLIC_KEY: keys.publicKey, WAFFO_MERCHANT_ID: "local-merchant", WAFFO_ENVIRONMENT: "sandbox",
    } as RuntimeEnv;
    const store = new D1Store(platform.env.DB as unknown as Env["DB"]);
    const user = (await store.list<User>("users")).items[0];
    expect(user).toBeTruthy();
    await store.patchUser(user!.id, { balanceMinor: 0, appliedPaymentIds: [] });
    const createdAt = new Date().toISOString();
    const order: Order = {
      id: "local-close-then-success-order", userId: user!.id, planId: null, type: "topup", amountMinor: 250,
      currency: "USD", provider: "waffo", providerOrderId: null, checkoutUrl: null, status: "pending",
      expiresAt: new Date(Date.now() + 60_000).toISOString(), paidAt: null, metadata: {}, createdAt, updatedAt: createdAt,
    };
    await store.put("orders", order.id, order);
    const inquiryBody = JSON.stringify({
      code: "0", msg: "success", data: {
        paymentRequestId: order.id, merchantOrderId: order.id, acquiringOrderId: "acquiring-local-order",
        orderStatus: "PAY_SUCCESS", orderAmount: "2.50", orderCurrency: "USD",
      },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api-sandbox.waffo.com/api/v1/order/inquiry");
      expect(JSON.parse(String(init?.body))).toEqual({ paymentRequestId: order.id });
      expect(new Headers(init?.headers).get("X-API-KEY")).toBe("local-waffo-test-key");
      expect(new Headers(init?.headers).get("X-API-VERSION")).toBe("1.0.0");
      expect(new Headers(init?.headers).get("X-SIGNATURE")).toBeTruthy();
      return new Response(inquiryBody, { status: 200, headers: { "X-SIGNATURE": signPayload(inquiryBody, keys.privateKey) } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const notify = async (orderStatus: "ORDER_CLOSE" | "PAY_SUCCESS") => {
      const body = JSON.stringify({ eventType: "PAYMENT_NOTIFICATION", result: {
        merchantOrderId: order.id, paymentRequestId: order.id, orderStatus, orderAmount: "2.50", orderCurrency: "USD",
      } });
      return request("/api/webhooks/waffo", {
        method: "POST", headers: { "Content-Type": "application/json", "X-SIGNATURE": signPayload(body, keys.privateKey) }, body,
      });
    };

    try {
      const closeResponse = await notify("ORDER_CLOSE");
      expect(closeResponse.status).toBe(200);
      expect(await closeResponse.json()).toEqual({ message: "success" });
      expect(await store.get<Order>("orders", order.id)).toMatchObject({ status: "failed" });

      const lateSuccess = await notify("PAY_SUCCESS");
      expect(lateSuccess.status).toBe(200);
      expect(await lateSuccess.json()).toEqual({ message: "success" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await store.get<Order>("orders", order.id)).toMatchObject({ status: "paid" });
      expect(await store.get<User>("users", user!.id)).toMatchObject({ balanceMinor: 250, appliedPaymentIds: [order.id] });
      expect((await store.list("ledger-entries", { prefix: `payment:${order.id}` })).items).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
      env = previousEnv;
    }
  });

  it("keeps a failed order closed when inquiry confirms ORDER_CLOSE", async () => {
    const keys = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const previousEnv = env;
    env = {
      ...env, WAFFO_API_KEY: "local-waffo-test-key", WAFFO_SIGNING_KEY: keys.privateKey,
      WAFFO_PUBLIC_KEY: keys.publicKey, WAFFO_MERCHANT_ID: "local-merchant", WAFFO_ENVIRONMENT: "sandbox",
    } as RuntimeEnv;
    const store = new D1Store(platform.env.DB as unknown as Env["DB"]);
    const user = (await store.list<User>("users")).items[0];
    expect(user).toBeTruthy();
    await store.patchUser(user!.id, { balanceMinor: 0, appliedPaymentIds: [] });
    const createdAt = new Date().toISOString();
    const order: Order = {
      id: "local-close-confirmed-order", userId: user!.id, planId: null, type: "topup", amountMinor: 250,
      currency: "USD", provider: "waffo", providerOrderId: null, checkoutUrl: null, status: "pending",
      expiresAt: new Date(Date.now() + 60_000).toISOString(), paidAt: null, metadata: {}, createdAt, updatedAt: createdAt,
    };
    await store.put("orders", order.id, order);
    const inquiryBody = JSON.stringify({
      code: "0", msg: "success", data: {
        paymentRequestId: order.id, merchantOrderId: order.id, acquiringOrderId: "acquiring-local-order",
        orderStatus: "ORDER_CLOSE", orderAmount: "2.50", orderCurrency: "USD",
      },
    });
    const fetchMock = vi.fn(async () => new Response(inquiryBody, {
      status: 200, headers: { "X-SIGNATURE": signPayload(inquiryBody, keys.privateKey) },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const notify = async (orderStatus: "ORDER_CLOSE" | "PAY_SUCCESS", targetOrder: Order = order) => {
      const body = JSON.stringify({ eventType: "PAYMENT_NOTIFICATION", result: {
        merchantOrderId: targetOrder.id, paymentRequestId: targetOrder.id, orderStatus, orderAmount: "2.50", orderCurrency: "USD",
      } });
      return request("/api/webhooks/waffo", {
        method: "POST", headers: { "Content-Type": "application/json", "X-SIGNATURE": signPayload(body, keys.privateKey) }, body,
      });
    };

    try {
      await notify("ORDER_CLOSE");
      const lateSuccess = await notify("PAY_SUCCESS");
      expect(lateSuccess.status).toBe(200);
      expect(await lateSuccess.json()).toEqual({ message: "success" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await store.get<Order>("orders", order.id)).toMatchObject({ status: "failed" });
      expect(await store.get<User>("users", user!.id)).toMatchObject({ balanceMinor: 0, appliedPaymentIds: [] });

      const retryOrder: Order = { ...order, id: "local-inquiry-retry-order", status: "pending" };
      await store.put("orders", retryOrder.id, retryOrder);
      await notify("ORDER_CLOSE", retryOrder);
      fetchMock.mockRejectedValueOnce(new Error("Local Waffo inquiry failure"));
      const retryable = await notify("PAY_SUCCESS", retryOrder);
      expect(retryable.status).toBe(200);
      expect(await retryable.json()).toEqual({ message: "failed" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(await store.get<Order>("orders", retryOrder.id)).toMatchObject({ status: "failed" });
      expect(await store.get<User>("users", user!.id)).toMatchObject({ balanceMinor: 0, appliedPaymentIds: [] });
    } finally {
      vi.unstubAllGlobals();
      env = previousEnv;
    }
  });

  it.each([
    { scenario: "invalid signature", validSignature: false, overrides: {} },
    { scenario: "different order", validSignature: true, overrides: { paymentRequestId: "another-order", merchantOrderId: "another-order" } },
    { scenario: "amount mismatch", validSignature: true, overrides: { orderAmount: "2.49" } },
    { scenario: "currency mismatch", validSignature: true, overrides: { orderCurrency: "EUR" } },
    { scenario: "nonterminal status", validSignature: true, overrides: { orderStatus: "PAY_IN_PROGRESS" } },
  ])("does not settle a failed order when inquiry has $scenario", async ({ scenario, validSignature, overrides }) => {
    const merchantKeys = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const providerKeys = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const previousEnv = env;
    env = {
      ...env, WAFFO_API_KEY: "local-waffo-test-key", WAFFO_SIGNING_KEY: merchantKeys.privateKey,
      WAFFO_PUBLIC_KEY: providerKeys.publicKey, WAFFO_MERCHANT_ID: "local-merchant", WAFFO_ENVIRONMENT: "sandbox",
    } as RuntimeEnv;
    const store = new D1Store(platform.env.DB as unknown as Env["DB"]);
    const user = (await store.list<User>("users")).items[0];
    expect(user).toBeTruthy();
    await store.patchUser(user!.id, { balanceMinor: 0, appliedPaymentIds: [] });
    const createdAt = new Date().toISOString();
    const order: Order = {
      id: `local-inquiry-rejected-${scenario.replaceAll(" ", "-")}`, userId: user!.id, planId: null, type: "topup", amountMinor: 250,
      currency: "USD", provider: "waffo", providerOrderId: null, checkoutUrl: null, status: "failed",
      expiresAt: new Date(Date.now() + 60_000).toISOString(), paidAt: null, metadata: {}, createdAt, updatedAt: createdAt,
    };
    await store.put("orders", order.id, order);
    const inquiryBody = JSON.stringify({
      code: "0", msg: "success", data: {
        paymentRequestId: order.id, merchantOrderId: order.id, orderStatus: "PAY_SUCCESS", orderAmount: "2.50", orderCurrency: "USD",
        ...overrides,
      },
    });
    const responseSigningKey = validSignature ? providerKeys.privateKey : merchantKeys.privateKey;
    const fetchMock = vi.fn(async () => new Response(inquiryBody, {
      status: 200, headers: { "X-SIGNATURE": signPayload(inquiryBody, responseSigningKey) },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const body = JSON.stringify({ eventType: "PAYMENT_NOTIFICATION", result: {
      merchantOrderId: order.id, paymentRequestId: order.id, orderStatus: "PAY_SUCCESS", orderAmount: "2.50", orderCurrency: "USD",
    } });

    try {
      const response = await request("/api/webhooks/waffo", {
        method: "POST", headers: { "Content-Type": "application/json", "X-SIGNATURE": signPayload(body, providerKeys.privateKey) }, body,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ message: "failed" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await store.get<Order>("orders", order.id)).toMatchObject({ status: "failed" });
      expect(await store.get<User>("users", user!.id)).toMatchObject({ balanceMinor: 0, appliedPaymentIds: [] });
      expect((await store.list("ledger-entries", { prefix: `payment:${order.id}` })).items).toHaveLength(0);
    } finally {
      vi.unstubAllGlobals();
      env = previousEnv;
    }
  });

  it("does not downgrade a paid order when a stale close notification arrives", async () => {
    const store = new D1Store(platform.env.DB as unknown as Env["DB"]);
    const users = await (await request("/api/admin/users", { headers: { Cookie: cookie, Origin: "https://manager.test" } })).json() as { items: User[] };
    const user = await store.get<User>("users", users.items[0].id);
    expect(user).toBeTruthy();
    await store.patchUser(user!.id, { balanceMinor: 0, appliedPaymentIds: [] });
    const createdAt = new Date().toISOString();
    const order: Order = {
      id: "local-topup-race-order", userId: user!.id, planId: null, type: "topup", amountMinor: 250,
      currency: "USD", provider: "waffo", providerOrderId: null, checkoutUrl: null, status: "pending",
      expiresAt: new Date(Date.now() + 60_000).toISOString(), paidAt: null, metadata: {}, createdAt, updatedAt: createdAt,
    };
    await store.put("orders", order.id, order);
    const staleOrder = await store.get<Order>("orders", order.id);
    expect(staleOrder).toBeTruthy();

    await settlePaidOrder(store, env, staleOrder!, "race-success-event");
    await settleFailedOrder(store, staleOrder!, "late-close-event");

    expect(await store.get<Order>("orders", order.id)).toMatchObject({ status: "paid" });
    expect(await store.get<User>("users", user!.id)).toMatchObject({ balanceMinor: 250, appliedPaymentIds: [order.id] });
    expect((await store.list("ledger-entries", { prefix: `payment:${order.id}` })).items).toHaveLength(1);
  });

  it("credits a referral commission atomically and idempotently within the configured window", async () => {
    const store = new D1Store(platform.env.DB as unknown as Env["DB"]);
    const base = (await store.list<User>("users")).items[0];
    expect(base).toBeTruthy();
    const now = new Date().toISOString();
    const inviter: User = { ...base!, id: `referrer-${crypto.randomUUID()}`, email: `referrer-${crypto.randomUUID()}@example.test`, role: "user", balanceMinor: 0, inviteCode: null, invitedBy: null, inviteCount: 0, createdAt: now, lastActiveAt: now, updatedAt: now, appliedPaymentIds: [] };
    const referred: User = { ...base!, id: `referred-${crypto.randomUUID()}`, email: `referred-${crypto.randomUUID()}@example.test`, role: "user", balanceMinor: 0, inviteCode: null, invitedBy: inviter.id, inviteCount: 0, createdAt: now, lastActiveAt: now, updatedAt: now, appliedPaymentIds: [] };
    const settingKeys = ["referralPercent", "referralValidityDays", "notifyReferralReward"];
    const oldSettings = new Map<string, unknown | null>();
    for (const key of settingKeys) oldSettings.set(key, await store.get("settings", key));
    const orderId = `referral-order-${crypto.randomUUID()}`;
    const order: Order = {
      id: orderId, userId: referred.id, planId: null, type: "topup", amountMinor: 1000,
      currency: "USD", provider: "waffo", providerOrderId: null, checkoutUrl: null, status: "pending",
      expiresAt: new Date(Date.now() + 60_000).toISOString(), paidAt: null, metadata: {}, createdAt: now, updatedAt: now,
    };
    try {
      await store.put("users", inviter.id, inviter);
      await store.put("users", referred.id, referred);
      await store.put("orders", order.id, order);
      await store.put("settings", "referralPercent", { key: "referralPercent", value: 10, updatedAt: now });
      await store.put("settings", "referralValidityDays", { key: "referralValidityDays", value: 30, updatedAt: now });
      await store.put("settings", "notifyReferralReward", { key: "notifyReferralReward", value: false, updatedAt: now });

      await settlePaidOrder(store, env, order, "referral-event");
      await settlePaidOrder(store, env, order, "referral-event-replay");

      expect(await store.get<User>("users", referred.id)).toMatchObject({ balanceMinor: 1000, appliedPaymentIds: [order.id] });
      expect(await store.get<User>("users", inviter.id)).toMatchObject({ balanceMinor: 100 });
      expect(await store.get("ledger-entries", `referral:${order.id}`)).toMatchObject({ userId: inviter.id, amountMinor: 100, currency: "USD" });
      expect(await store.get(`${"notifications"}`, `${inviter.id}:referral-reward:${order.id}`)).toMatchObject({ type: "referral-reward", userId: inviter.id });
    } finally {
      await store.delete("users", inviter.id);
      await store.delete("users", referred.id);
      await store.delete("orders", order.id);
      await store.delete("ledger-entries", `payment:${order.id}`);
      await store.delete("ledger-entries", `referral:${order.id}`);
      await store.delete("notifications", `${inviter.id}:referral-reward:${order.id}`);
      for (const [key, value] of oldSettings) {
        if (value === null) await store.delete("settings", key);
        else await store.put("settings", key, value);
      }
    }
  });

  it("expires pending orders and provides owner-scoped read notifications", async () => {
    const store = new D1Store(platform.env.DB as unknown as Env["DB"]);
    const owner = (await store.list<User>("users")).items[0];
    expect(owner).toBeTruthy();
    const now = new Date().toISOString();
    const orderId = `expired-order-${crypto.randomUUID()}`;
    const notificationId = `order-expired:${orderId}`;
    const order: Order = {
      id: orderId, userId: owner!.id, planId: null, type: "topup", amountMinor: 100,
      currency: "USD", provider: "waffo", providerOrderId: null, checkoutUrl: null, status: "pending",
      expiresAt: new Date(Date.now() - 60_000).toISOString(), paidAt: null, metadata: {}, createdAt: now, updatedAt: now,
    };
    const oldSetting = await store.get("settings", "notifyOrderExpired");
    try {
      await store.put("settings", "notifyOrderExpired", { key: "notifyOrderExpired", value: false, updatedAt: now });
      await store.put("orders", order.id, order);
      await expirePendingOrders(store, env, new Date());
      expect(await store.get<Order>("orders", order.id)).toMatchObject({ status: "expired" });

      const headers = { Cookie: cookie, Origin: "https://manager.test" };
      const list = await request("/api/user/notifications", { headers });
      expect(list.status).toBe(200);
      const listed = await list.json() as { items: Array<{ id: string; readAt: string | null }>; unreadCount: number };
      expect(listed.items).toContainEqual(expect.objectContaining({ id: notificationId, readAt: null }));
      const read = await request(`/api/user/notifications/${encodeURIComponent(notificationId)}/read`, { method: "POST", headers });
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({ notification: { id: notificationId, readAt: expect.any(String) } });
      const foreign = await request(`/api/user/notifications/${encodeURIComponent("unknown:notification")}/read`, { method: "POST", headers });
      expect(foreign.status).toBe(404);
    } finally {
      await store.delete("orders", order.id);
      await store.delete("notifications", `${owner!.id}:${notificationId}`);
      if (oldSetting === null) await store.delete("settings", "notifyOrderExpired");
      else await store.put("settings", "notifyOrderExpired", oldSetting);
    }
  });

  it("runs opt-in account cleanup only after its warning period", async () => {
    const store = new D1Store(platform.env.DB as unknown as Env["DB"]);
    const base = (await store.list<User>("users")).items[0];
    expect(base).toBeTruthy();
    const id = `retention-user-${crypto.randomUUID()}`;
    const email = `${id}@example.test`;
    const old = new Date(Date.now() - 2 * 86400000).toISOString();
    const user: User = { ...base!, id, email, role: "user", balanceMinor: 0, planId: "plan-free", planLevel: 0, planExpiresAt: null, planTrafficBytes: 0, billedBytes: 0, inviteCode: null, invitedBy: null, inviteCount: 0, checkinStreak: 0, lastCheckinAt: null, lastActiveAt: old, createdAt: old, updatedAt: old, appliedPaymentIds: [] };
    const settingKeys = ["deleteInactiveAfterDays", "deleteWithoutPlanAfterDays", "warnBeforeDeleteDays", "notifyAccountCleanup"];
    const oldSettings = new Map<string, unknown | null>();
    for (const key of settingKeys) oldSettings.set(key, await store.get("settings", key));
    try {
      await store.put("users", user.id, user);
      await store.put("user-email", user.email, { userId: user.id });
      await store.put("settings", "deleteInactiveAfterDays", { key: "deleteInactiveAfterDays", value: 0, updatedAt: old });
      await store.put("settings", "deleteWithoutPlanAfterDays", { key: "deleteWithoutPlanAfterDays", value: 1, updatedAt: old });
      await store.put("settings", "warnBeforeDeleteDays", { key: "warnBeforeDeleteDays", value: 0, updatedAt: old });
      await store.put("settings", "notifyAccountCleanup", { key: "notifyAccountCleanup", value: false, updatedAt: old });

      await runLifecycleMaintenance(env);

      expect(await store.get<User>("users", user.id)).toBeNull();
      expect(await store.get("user-email", user.email)).toBeNull();
    } finally {
      await store.delete("users", user.id);
      await store.delete("user-email", user.email);
      await store.delete("account-retention", user.id);
      for (const [key, value] of oldSettings) {
        if (value === null) await store.delete("settings", key);
        else await store.put("settings", key, value);
      }
    }
  });

  it("delivers an opted-in notification once through a mocked email provider", async () => {
    const store = new D1Store(platform.env.DB as unknown as Env["DB"]);
    const user = (await store.list<User>("users")).items[0];
    expect(user).toBeTruthy();
    const id = `email-notification-${crypto.randomUUID()}`;
    const emailEnv = { ...env, RESEND_API_KEY: "local-resend-test-key", RESEND_FROM: "Test <noreply@example.test>" } as RuntimeEnv;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.resend.com/emails");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer local-resend-test-key");
      const message = JSON.parse(String(init?.body)) as { to: string[]; html: string };
      expect(message.to).toEqual([user!.email]);
      expect(message.html).toContain("&lt;img src=x&gt;");
      return new Response(JSON.stringify({ id: "local-email-id" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const notification = await createUserNotification(store, emailEnv, {
        id, userId: user!.id, type: "traffic-reset", title: "Local delivery test", body: "<img src=x>", emailEnabled: true,
      });
      expect(notification).toMatchObject({ id, emailStatus: "sent", emailAttempts: 1 });
      const replay = await createUserNotification(store, emailEnv, {
        id, userId: user!.id, type: "traffic-reset", title: "Local delivery test", body: "<img src=x>", emailEnabled: true,
      });
      expect(replay).toMatchObject({ emailStatus: "sent", emailAttempts: 1 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      await store.delete("notifications", `${user!.id}:${id}`);
    }
  });

  it("settles a payment idempotently and records its ledger entry", async () => {
    const store = new D1Store(platform.env.DB as unknown as Env["DB"]);
    const users = await (await request("/api/admin/users", { headers: { Cookie: cookie, Origin: "https://manager.test" } })).json() as { items: User[] };
    const user = await store.get<User>("users", users.items[0].id);
    expect(user).toBeTruthy();
    await store.patchUser(user!.id, { balanceMinor: 10, appliedPaymentIds: [] });
    const createdAt = new Date().toISOString();
    const order: Order = {
      id: "local-topup-order", userId: user!.id, planId: null, type: "topup", amountMinor: 250,
      currency: "USD", provider: "waffo", providerOrderId: null, checkoutUrl: null, status: "pending",
      expiresAt: new Date(Date.now() + 60_000).toISOString(), paidAt: null, metadata: {}, createdAt, updatedAt: createdAt,
    };
    await store.put("orders", order.id, order);

    await settlePaidOrder(store, env, order, "local-webhook-event");
    await settlePaidOrder(store, env, order, "local-webhook-event-replay");

    expect(await store.get<User>("users", user!.id)).toMatchObject({ balanceMinor: 260, appliedPaymentIds: [order.id] });
    const ledger = await store.list("ledger-entries", { prefix: `payment:${order.id}` });
    expect(ledger.items).toHaveLength(1);
    expect(await store.get<Order>("orders", order.id)).toMatchObject({ status: "paid" });
  });

  const balancePlan = (id: string, level: number, priceMinor: number): Plan => ({
    id, name: id, description: "", group: "default", level, trafficBytes: level * 1000, validityDays: 30,
    resetUnit: "month", resetInterval: 1, resetAtHour: 0, resetWeekday: 1, resetMonthDay: 1,
    priceMinor, currency: "USD", allowPaidUpgrade: true, isDefault: false, enabled: true,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const balanceUser = (id: string, balanceMinor: number): User => ({
    id, email: `${id}@example.test`, passwordHash: "", emailVerifiedAt: null, role: "user", balanceMinor,
    planId: "balance-current", planLevel: 1, planExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
    planTrafficBytes: 1000, billedBytes: 0, planStartedAt: new Date().toISOString(), trafficResetAt: null,
    enabled: true, inviteCode: null, invitedBy: null, inviteCount: 0, checkinStreak: 0, lastCheckinAt: null,
    lastActiveAt: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), appliedPaymentIds: [],
  });
  const noopPanel = () => vi.spyOn(ThreeXuiClient, "connect").mockResolvedValue({
    upsertClient: async () => undefined, disableClient: async () => undefined,
  } as unknown as ThreeXuiClient);

  it("pays a paid upgrade from the account balance before creating an order", async () => {
    const store = new D1Store(platform.env.DB as unknown as Env["DB"]);
    const current = balancePlan("balance-current", 1, 1000);
    const next = balancePlan("balance-next", 2, 3000);
    const user = balanceUser(`local-balance-full-${crypto.randomUUID()}`, 5000);
    const connect = noopPanel();
    try {
      await store.put("plans", current.id, current);
      await store.put("plans", next.id, next);
      await store.put("users", user.id, user);

      const result = await createCheckout(store, env, user, { type: "upgrade", provider: "waffo", planId: next.id });

      expect(result).toMatchObject({ order: null, checkoutUrl: null, appliedWithoutPayment: true, balanceAppliedMinor: 2000 });
      expect(await store.get<User>("users", user.id)).toMatchObject({ planId: next.id, planLevel: 2, balanceMinor: 3000 });
      expect((await store.list("orders")).items).not.toContainEqual(expect.objectContaining({ userId: user.id }));
      const ledger = await store.list<{ amountMinor: number; kind: string }>("ledger-entries", { prefix: "balance-payment:" });
      expect(ledger.items).toContainEqual(expect.objectContaining({ userId: user.id, kind: "balance_payment", amountMinor: -2000 }));
    } finally {
      connect.mockRestore();
      for (const entry of (await store.list<{ id: string }>("ledger-entries", { prefix: "balance-payment:" })).items) await store.delete("ledger-entries", entry.id);
      await store.delete("users", user.id);
      await store.delete("plans", current.id);
      await store.delete("plans", next.id);
    }
  });

  it("reserves balance for a partial upgrade and releases or re-charges it with the order lifecycle", async () => {
    const keys = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const previousEnv = env;
    env = {
      ...env, WAFFO_API_KEY: "local-waffo-test-key", WAFFO_SIGNING_KEY: keys.privateKey, WAFFO_PUBLIC_KEY: keys.publicKey,
      WAFFO_MERCHANT_ID: "local-merchant", WAFFO_ENVIRONMENT: "sandbox", PUBLIC_APP_URL: "https://manager.example.test",
    } as RuntimeEnv;
    const store = new D1Store(platform.env.DB as unknown as Env["DB"]);
    const current = balancePlan("balance-current", 1, 1000);
    const next = balancePlan("balance-next", 2, 3000);
    const user = balanceUser(`local-balance-partial-${crypto.randomUUID()}`, 500);
    const providerBody = JSON.stringify({
      code: "0", msg: "success",
      data: { paymentRequestId: "req-local", merchantOrderId: "merchant-local", acquiringOrderId: "acq-local", orderAction: "https://pay.waffo.test/checkout/local-balance" },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(providerBody, { status: 200, headers: { "X-SIGNATURE": signPayload(providerBody, keys.privateKey) } })));
    const connect = noopPanel();
    let orderId = "";
    try {
      await store.put("plans", current.id, current);
      await store.put("plans", next.id, next);
      await store.put("users", user.id, user);

      const result = await createCheckout(store, env, user, { type: "upgrade", provider: "waffo", planId: next.id });
      orderId = result.order?.id ?? "";
      expect(result).toMatchObject({ checkoutUrl: "https://pay.waffo.test/checkout/local-balance", balanceAppliedMinor: 500 });
      expect(result.order).toMatchObject({ amountMinor: 1500, status: "pending" });
      expect(await store.get<User>("users", user.id)).toMatchObject({ balanceMinor: 0, planId: current.id });
      expect(await store.get<Order>("orders", orderId)).toMatchObject({ metadata: expect.objectContaining({ balanceAppliedMinor: 500 }) });

      const pending = await store.get<Order>("orders", orderId);
      await store.put("orders", orderId, { ...pending!, expiresAt: new Date(Date.now() - 60_000).toISOString() });
      expect(await expirePendingOrders(store, env, new Date())).toBeGreaterThanOrEqual(1);
      expect(await store.get<User>("users", user.id)).toMatchObject({ balanceMinor: 500, planId: current.id });
      expect(await store.get<Order>("orders", orderId)).toMatchObject({ status: "expired", metadata: expect.objectContaining({ balanceRefundedAt: expect.any(String) }) });

      const expired = await store.get<Order>("orders", orderId);
      await settlePaidOrder(store, env, expired!, "local-late-balance-event", "PAY_SUCCESS");
      expect(await store.get<User>("users", user.id)).toMatchObject({ balanceMinor: 0, planId: next.id });
      expect(await store.get<Order>("orders", orderId)).toMatchObject({ status: "paid", metadata: expect.objectContaining({ balanceRevivedAt: expect.any(String) }) });
    } finally {
      vi.unstubAllGlobals();
      connect.mockRestore();
      env = previousEnv;
      if (orderId) {
        for (const id of [`payment:${orderId}`, `balance-payment:${orderId}`, `balance-refund:${orderId}`, `balance-recharge:${orderId}`]) await store.delete("ledger-entries", id);
        await store.delete("orders", orderId);
      }
      await store.delete("users", user.id);
      await store.delete("plans", current.id);
      await store.delete("plans", next.id);
    }
  });

  it("returns the reserved balance when the provider checkout fails", async () => {
    const store = new D1Store(platform.env.DB as unknown as Env["DB"]);
    const current = balancePlan("balance-current", 1, 1000);
    const next = balancePlan("balance-next", 2, 3000);
    const user = balanceUser(`local-balance-failed-${crypto.randomUUID()}`, 500);
    const connect = noopPanel();
    let orderId = "";
    try {
      await store.put("plans", current.id, current);
      await store.put("plans", next.id, next);
      await store.put("users", user.id, user);

      await expect(createCheckout(store, env, user, { type: "upgrade", provider: "waffo", planId: next.id }))
        .rejects.toThrow("Waffo requires WAFFO_API_KEY");

      expect(await store.get<User>("users", user.id)).toMatchObject({ balanceMinor: 500, planId: current.id });
      const order = (await store.list<Order>("orders")).items.find((item) => item.userId === user.id);
      orderId = order?.id ?? "";
      expect(order).toMatchObject({ status: "pending", amountMinor: 1500, metadata: expect.objectContaining({ balanceAppliedMinor: 500, balanceRefundedAt: expect.any(String) }) });
      expect(await store.get("ledger-entries", `balance-refund:${orderId}`)).toMatchObject({ kind: "balance_refund", amountMinor: 500 });
    } finally {
      connect.mockRestore();
      if (orderId) {
        for (const id of [`balance-payment:${orderId}`, `balance-refund:${orderId}`]) await store.delete("ledger-entries", id);
        await store.delete("orders", orderId);
      }
      await store.delete("users", user.id);
      await store.delete("plans", current.id);
      await store.delete("plans", next.id);
    }
  });

  it("lets the default free plan carry traffic and validity for new accounts", async () => {
    const store = new D1Store(platform.env.DB as unknown as Env["DB"]);
    const headers = { Cookie: cookie, Origin: "https://manager.test", "Content-Type": "application/json" };
    const listed = await request("/api/admin/plans", { headers });
    expect(listed.status).toBe(200);
    const freePlan = (await listed.json() as { items: Plan[] }).items.find((plan) => plan.id === "plan-free");
    expect(freePlan).toBeTruthy();
    const original = { trafficBytes: freePlan!.trafficBytes, validityDays: freePlan!.validityDays };
    const settings = await Promise.all(["emailVerificationRequired", "registrationEnabled", "turnstileEnabled", "inviteRequired"].map(async (key) => [
      key, await store.get<{ key: string; value: unknown; updatedAt: string }>("settings", key),
    ] as const));
    const connect = noopPanel();
    let adminUserId = "";
    let adminEmail = "";
    let registeredUserId = "";
    let registeredEmail = "";
    try {
      const updated = await request("/api/admin/plans/plan-free", {
        method: "PATCH", headers, body: JSON.stringify({ trafficBytes: 5_000_000_000, validityDays: 30 }),
      });
      expect(updated.status).toBe(200);
      expect((await updated.json() as { plan: Plan }).plan).toMatchObject({ trafficBytes: 5_000_000_000, validityDays: 30, level: 0, priceMinor: 0 });

      const rejected = await request("/api/admin/plans/plan-free", { method: "PATCH", headers, body: JSON.stringify({ level: 2 }) });
      expect(rejected.status).toBe(422);

      adminEmail = `free-quota-${crypto.randomUUID()}@example.test`;
      const created = await request("/api/admin/users", {
        method: "POST", headers, body: JSON.stringify({ email: adminEmail, password: "local-test-password" }),
      });
      expect(created.status).toBe(201);
      const adminCreated = (await created.json() as { user: User }).user;
      adminUserId = adminCreated.id;
      expect(adminCreated).toMatchObject({ planId: "plan-free", planTrafficBytes: 5_000_000_000 });
      expect(adminCreated.planExpiresAt).toEqual(expect.any(String));

      for (const [key, value] of [["emailVerificationRequired", false], ["registrationEnabled", true], ["turnstileEnabled", false], ["inviteRequired", false]] as const) {
        await store.put("settings", key, { key, value, updatedAt: new Date().toISOString() });
      }
      registeredEmail = `free-register-${crypto.randomUUID()}@example.test`;
      const registered = await request("/api/auth/register", {
        method: "POST", headers: { Origin: "https://manager.test", "Content-Type": "application/json" },
        body: JSON.stringify({ email: registeredEmail, password: "local-test-password" }),
      });
      expect(registered.status).toBe(201);
      const registeredUser = (await registered.json() as { user: User }).user;
      registeredUserId = registeredUser.id;
      expect(registeredUser).toMatchObject({ planId: "plan-free", planTrafficBytes: 5_000_000_000 });
    } finally {
      connect.mockRestore();
      const plan = await store.get<Plan>("plans", "plan-free");
      if (plan) await store.put("plans", "plan-free", { ...plan, ...original });
      if (adminUserId) {
        await store.delete("users", adminUserId);
        await store.delete("user-email", adminEmail);
      }
      if (registeredUserId) {
        await store.delete("users", registeredUserId);
        await store.delete("user-email", registeredEmail);
      }
      for (const [key, row] of settings) {
        if (row) await store.put("settings", key, row);
      }
    }
  });
});
