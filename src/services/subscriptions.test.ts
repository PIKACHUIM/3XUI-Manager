import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { ApiEnv } from "../api/context";
import userApi from "../api/user";
import subscriptions from "../api/subscriptions";
import type { DocumentStore, ListOptions } from "../storage/store";
import type { ClientMapping, Inbound, NodeRecord, User } from "../domain/types";
import { encryptSecret, sha256 } from "../domain/security";
import { SESSION_COOKIE } from "../domain/defaults";
import { convertSubscriptionEntry, renderSubscription, subscriptionCredential, subscriptionUser } from "./subscriptions";

class MemoryStore implements DocumentStore {
  data = new Map<string, unknown>();
  async get<T>(c: string, id: string): Promise<T | null> { return this.data.get(`${c}/${id}`) as T ?? null; }
  async put<T>(c: string, id: string, v: T) { this.data.set(`${c}/${id}`, structuredClone(v)); }
  async delete(c: string, id: string) { this.data.delete(`${c}/${id}`); }
  async has(c: string, id: string) { return this.data.has(`${c}/${id}`); }
  async list<T>(c: string, options?: ListOptions) { return { items: [...this.data].filter(([k]) => k.startsWith(`${c}/${options?.prefix ?? ""}`)).map(([, v]) => v as T), cursor: null }; }
  async acquireLease() { return true; }
  async releaseLease() {}
}
const key = "subscription-test-encryption-key-32-chars";
const user = { id: "u", enabled: true, planId: "p", planLevel: 1, planTrafficBytes: 1000, billedBytes: 1, planExpiresAt: null } as User;
const node = { id: "n", name: "Tokyo", publicAddress: "edge.example.com", enabled: true, panelUrl: "https://private-panel", username: "admin-secret", encryptedPassword: "admin-password" } as NodeRecord;
const inbound = { id: "i", name: "日本", protocol: "vless", network: "tcp", port: 443, enabled: true, minimumLevel: 1, multiplier: 1, createdAt: "2026-01-01", updatedAt: "2026-01-01", config: { settings: { decryption: "none" }, streamSettings: { security: "tls", tlsSettings: { serverName: "edge.example.com" } } } } as Inbound;
const mapping = { id: "u:i", userId: "u", inboundId: "i", email: "u_i", clientId: "12345678-1234-1234-1234-123456789012", flow: "", enable: true, syncStatus: "synced", syncedNodes: ["n"] } as ClientMapping;
async function setup() {
  const store = new MemoryStore();
  await store.put("users", "u", user); await store.put("plans", "p", { enabled: true });
  await store.put("inbounds", "i", inbound); await store.put("nodes", "n", node); await store.put("clients", "u:i", mapping);
  await store.put("inbound-node-bindings", "i:n", { inboundId: "i", nodeId: "n", panelInboundId: 1 });
  await store.put("sessions", await sha256("session"), { userId: "u", expiresAt: "2099-01-01T00:00:00Z" });
  const app = new Hono<ApiEnv>(); app.use("*", async (c, next) => { c.set("store", store); await next(); });
  app.route("/api/user", userApi); app.route("/api/subscriptions", subscriptions);
  const request = (path: string, init?: RequestInit) => app.request(`https://manager.test${path}`, init, { APP_ENCRYPTION_KEY: key } as ApiEnv["Bindings"]);
  return { store, request };
}

describe("subscription formats", () => {
  it("exports TLS VLESS, Unicode VMess/ws, Trojan/grpc and Reality without panel credentials", async () => {
    const vless = await convertSubscriptionEntry(inbound, node, mapping, key);
    expect(vless?.clash).toMatchObject({ type: "vless", tls: true, uuid: mapping.clientId });
    expect(vless?.uri).toContain("vless://");
    const vmess = await convertSubscriptionEntry({ ...inbound, protocol: "vmess", config: { streamSettings: { network: "ws", security: "tls", wsSettings: { path: "/socket", headers: { Host: "ws.example.com" } } } } }, node, mapping, key);
    const vmessJson = JSON.parse(Buffer.from(vmess!.uri.slice(8), "base64").toString("utf8"));
    expect(vmessJson).toMatchObject({ ps: expect.stringContaining("日本"), net: "ws", path: "/socket", host: "ws.example.com" });
    const trojan = await convertSubscriptionEntry({ ...inbound, protocol: "trojan", config: { streamSettings: { network: "grpc", security: "tls", grpcSettings: { serviceName: "rpc" } } } }, node, { ...mapping, encryptedSecret: await encryptSecret("real-password", key) }, key);
    expect(trojan?.clash).toMatchObject({ password: "real-password", "grpc-opts": { "grpc-service-name": "rpc" } });
    const reality = await convertSubscriptionEntry({ ...inbound, config: { streamSettings: { security: "reality", realitySettings: { privateKey: "NEVER-EXPORT", serverNames: ["tls.example.com"], shortIds: ["aabb"], settings: { publicKey: "public-key" } } } } }, node, { ...mapping, flow: "xtls-rprx-vision" }, key);
    expect(reality?.uri).toContain("pbk=public-key");
    expect(JSON.stringify([vless, vmess, trojan, reality])).not.toMatch(/NEVER-EXPORT|private-panel|admin-secret|admin-password/);
  });
  it("exports SIP008 only from actual SS client passwords, and rejects unsafe combinations", async () => {
    const ss = { ...inbound, protocol: "shadowsocks", config: { settings: { method: "aes-128-gcm", clients: [{ email: mapping.email, password: "ss-password" }] } } };
    const entry = await convertSubscriptionEntry(ss, node, mapping, key);
    expect(entry?.ss).toMatchObject({ method: "aes-128-gcm", password: "ss-password", server_port: 443 });
    const { store } = await setup(); await store.put("inbounds", "i", ss);
    const rendered = await renderSubscription(store, user, key, "shadowsocks");
    expect(JSON.parse(rendered.body)).toMatchObject({ version: 1, servers: [{ password: "ss-password" }] });
    expect(await convertSubscriptionEntry({ ...ss, config: { settings: { method: "aes-128-gcm" } } }, node, mapping, key)).toBeNull();
    expect(await convertSubscriptionEntry({ ...inbound, network: "xhttp" }, node, mapping, key)).toBeNull();
    expect(await convertSubscriptionEntry({ ...inbound, shareAddrStrategy: "custom", shareAddr: "https://bad/path" }, node, mapping, key)).toBeNull();
    expect(await convertSubscriptionEntry({ ...inbound, shareAddrStrategy: "custom", shareAddr: "0.0.0.0" }, node, mapping, key)).toBeNull();
  });
  it("falls back to the node address when the listen strategy has no usable address", async () => {
    const entry = await convertSubscriptionEntry({ ...inbound, shareAddrStrategy: "listen", listen: "" }, node, mapping, key);
    expect(entry?.clash).toMatchObject({ server: "edge.example.com" });
    const wildcard = await convertSubscriptionEntry({ ...inbound, shareAddrStrategy: "listen", listen: "0.0.0.0" }, node, mapping, key);
    expect(wildcard?.clash).toMatchObject({ server: "edge.example.com" });
    const custom = await convertSubscriptionEntry({ ...inbound, shareAddrStrategy: "custom", shareAddr: "203.0.113.9" }, node, mapping, key);
    expect(custom?.clash).toMatchObject({ server: "203.0.113.9" });
  });
  it("keeps the VLESS ML-KEM encryption string the panel publishes", async () => {
    const encrypted = {
      ...inbound,
      config: {
        settings: { decryption: "mlkem768x25519plus.native.600s.server-key", encryption: "mlkem768x25519plus.native.0rtt.client-key" },
        streamSettings: { security: "tls", tlsSettings: { serverName: "edge.example.com" } },
      },
    };
    const entry = await convertSubscriptionEntry(encrypted, node, mapping, key);
    expect(entry?.clash).toMatchObject({ encryption: "mlkem768x25519plus.native.0rtt.client-key" });
    expect(entry?.uri).toContain("encryption=mlkem768x25519plus.native.0rtt.client-key");
    const plain = await convertSubscriptionEntry(inbound, node, mapping, key);
    expect(plain?.uri).toContain("encryption=none");
    expect(plain?.clash.encryption).toBeUndefined();
    const missing = { ...encrypted, config: { ...encrypted.config, settings: { decryption: "mlkem768x25519plus.native.600s.server-key" } } };
    expect(await convertSubscriptionEntry(missing, node, mapping, key)).toBeNull();
  });
  it("filters excluded, privileged, unsynced, disabled and unbound entries", async () => {
    const { store } = await setup();
    expect((await renderSubscription(store, user, key, "clash")).count).toBe(1);
    for (const patch of [{ excludeFromSub: true }, { minimumLevel: 2 }, { enabled: false }, { planEnabled: false }, { expiryTime: 1 }]) {
      await store.put("inbounds", "i", { ...inbound, ...patch });
      expect((await renderSubscription(store, user, key, "clash")).count).toBe(0);
    }
    await store.put("inbounds", "i", inbound);
    for (const patch of [{ syncStatus: "failed" }, { syncStatus: "partial" }, { enable: false }, { syncedNodes: [] }, { userId: "other" }]) {
      await store.put("clients", "u:i", { ...mapping, ...patch });
      expect((await renderSubscription(store, user, key, "v2ray")).count).toBe(0);
    }
    await store.put("clients", "u:i", mapping); await store.put("nodes", "n", { ...node, enabled: false });
    expect((await renderSubscription(store, user, key, "clash")).count).toBe(0);
  });
});

describe("subscription authorization", () => {
  it("requires login and same origin, reuses encrypted token, rotates and invalidates old links", async () => {
    const { store, request } = await setup();
    const headers = { Cookie: `${SESSION_COOKIE}=session`, Origin: "https://manager.test" };
    expect((await request("/api/user/subscription/links", { method: "POST" })).status).toBe(401);
    expect((await request("/api/user/subscription/reset", { method: "POST", headers: { ...headers, Origin: "https://evil.test" } })).status).toBe(403);
    const first = await (await request("/api/user/subscription/links", { method: "POST", headers })).json() as { links: Record<string, string> };
    expect(new Set(Object.values(first.links)).size).toBe(3);
    const firstToken = new URL(first.links.clash!).pathname.split("/").pop()!;
    expect(JSON.stringify([...store.data])).not.toContain(firstToken);
    expect((await subscriptionCredential(store, "u", key)).token).toBe(firstToken);
    const clash = await request(new URL(first.links.clash!).pathname + "?format=clash");
    expect(clash.status).toBe(200); expect(clash.headers.get("content-type")).toContain("application/yaml");
    expect(clash.headers.get("cache-control")).toContain("no-store");
    const v2ray = await request(new URL(first.links.v2ray!).pathname + "?format=v2ray");
    expect(atob(await v2ray.text())).toContain("vless://");
    expect((await request(new URL(first.links.shadowsocks!).pathname + "?format=shadowsocks")).status).toBe(422);
    expect((await request(new URL(first.links.clash!).pathname + "?format=invalid")).status).toBe(400);
    expect((await request("/api/user/subscription/reset", { method: "POST", headers })).status).toBe(200);
    expect(await subscriptionUser(store, firstToken)).toBeNull();
    expect((await request(new URL(first.links.clash!).pathname + "?format=clash")).status).toBe(404);
    expect((await request("/api/subscriptions/guessed?format=clash")).status).toBe(404);
  });
  it("denies expired, disabled and exhausted accounts and disabled plans", async () => {
    const { store, request } = await setup(); const { token } = await subscriptionCredential(store, "u", key);
    for (const patch of [{ enabled: false }, { billedBytes: 1000 }, { planExpiresAt: "2020-01-01" }, { planExpiresAt: "invalid" }]) {
      await store.put("users", "u", { ...user, ...patch });
      expect((await request(`/api/subscriptions/${token}?format=clash`)).status).toBe(403);
    }
    await store.put("users", "u", user); await store.put("plans", "p", { enabled: false });
    expect((await request(`/api/subscriptions/${token}?format=clash`)).status).toBe(403);
  });
});
