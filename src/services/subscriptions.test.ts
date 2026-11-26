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
    expect(reality?.clash).toMatchObject({
      tls: true, servername: "tls.example.com", "client-fingerprint": "chrome", flow: "xtls-rprx-vision",
      "reality-opts": { "public-key": "public-key", "short-id": "aabb", "support-x25519mlkem768": true },
    });
    expect(vless?.clash["reality-opts"]).toBeUndefined();
    expect(JSON.stringify([vless, vmess, trojan, reality])).not.toMatch(/NEVER-EXPORT|private-panel|admin-secret|admin-password/);
  });
  it("exports Hysteria2 with the per-client auth token and its Salamander obfs password", async () => {
    const hysteria = {
      ...inbound,
      protocol: "hysteria",
      port: 61092,
      config: {
        settings: { version: 2 },
        streamSettings: {
          network: "hysteria",
          security: "tls",
          hysteriaSettings: { version: 2, udpIdleTimeout: 60 },
          tlsSettings: { serverName: "", alpn: ["h3"] },
          finalmask: { udp: [{ type: "salamander", settings: { password: "obfs-secret" } }] },
        },
      },
    } as Inbound;
    const entry = await convertSubscriptionEntry(hysteria, node, mapping, key);
    expect(entry?.clash).toMatchObject({
      type: "hysteria2", server: "edge.example.com", port: 61092, password: mapping.clientId,
      "skip-cert-verify": true, obfs: "salamander", "obfs-password": "obfs-secret",
    });
    expect(entry?.uri.startsWith(`hysteria2://${mapping.clientId}@edge.example.com:61092?`)).toBe(true);
    expect(entry?.uri).toContain("obfs=salamander");
    expect(entry?.uri).toContain("insecure=1");
    expect(await convertSubscriptionEntry({ ...hysteria, config: { settings: { version: 2 }, streamSettings: { network: "hysteria", security: "tls", hysteriaSettings: { version: 1 } } } }, node, mapping, key)).toBeNull();
    const { store } = await setup(); await store.put("inbounds", "i", hysteria);
    const rendered = await renderSubscription(store, user, key, "clash");
    expect(rendered.body).toContain("type: \"hysteria2\"");
    expect(rendered.body).toContain("obfs-password: \"obfs-secret\"");
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
    for (const patch of [{ syncStatus: "failed" }, { enable: false }, { syncedNodes: [] }, { userId: "other" }]) {
      await store.put("clients", "u:i", { ...mapping, ...patch });
      expect((await renderSubscription(store, user, key, "v2ray")).count).toBe(0);
    }
    // A partial sync still serves the nodes that accepted the client.
    await store.put("clients", "u:i", { ...mapping, syncStatus: "partial" });
    expect((await renderSubscription(store, user, key, "v2ray")).count).toBe(1);
    await store.put("clients", "u:i", mapping); await store.put("nodes", "n", { ...node, enabled: false });
    expect((await renderSubscription(store, user, key, "clash")).count).toBe(0);
  });
  it("renders a full clash profile with settings, groups and rule categories", async () => {
    const { store } = await setup();
    await store.put("nodes", "n", { ...node, region: "日本" } as NodeRecord);
    await store.put("nodes", "n2", { ...node, id: "n2", name: "Osaka", region: "日本" } as NodeRecord);
    await store.put("inbound-node-bindings", "i:n2", { inboundId: "i", nodeId: "n2", panelInboundId: 2 });
    await store.put("clients", "u:i", { ...mapping, syncedNodes: ["n", "n2"] });

    const rendered = await renderSubscription(store, user, key, "clash");
    expect(rendered.count).toBe(2);
    expect(rendered.contentType).toContain("application/yaml");
    const body = rendered.body;
    expect(body.startsWith("# 3XUI Manager")).toBe(true);
    for (const line of [
      "mixed-port: 7890", 'mode: "rule"', "external-controller:", "dns:", 'enhanced-mode: "fake-ip"',
      "proxies:", "proxy-groups:", "rules:", '"选择节点"',
      '"🎬 爱奇艺&哔哩哔哩"', '"🛑 拦截广告"', "MATCH,🐟 漏网之鱼", "GEOIP,CN,🇨🇳 国内网站",
    ]) expect(body).toContain(line);
    expect(body).toContain('"日本 · Tokyo"');
    expect(body).toContain('"日本 · Osaka"');
    expect(body).not.toContain("Subscription");
    for (const gone of ["♻️ 自动选择", "🚑 故障转移", "📍 日本", 'type: "fallback"', 'type: "url-test"']) expect(body).not.toContain(gone);
    expect(body).toContain('name: "选择节点"\n    type: "select"');
    expect(body).toContain('proxies: ["选择节点", "日本 · Osaka", "日本 · Tokyo", "DIRECT"]');
    expect(body).toContain('proxies: ["DIRECT", "日本 · Osaka", "日本 · Tokyo", "选择节点"]');
    expect(body).toContain('proxies: ["REJECT", "DIRECT", "日本 · Osaka", "日本 · Tokyo", "选择节点"]');
  });
  it("sorts mainland entries first, then inbound and node order in every format", async () => {
    const { store } = await setup();
    const rows = [
      { id: "jp", name: "日本东京2", region: "东京", sortIndex: 0 },
      { id: "xa", name: "陕西西安1", region: "西安", sortIndex: 2 },
      { id: "js", name: "江苏镇江1", region: "江苏镇江", sortIndex: 1 },
    ];
    for (const row of rows) {
      await store.put("nodes", row.id, { ...node, ...row });
      await store.put("inbound-node-bindings", `i:${row.id}`, { inboundId: "i", nodeId: row.id, panelInboundId: 2 });
    }
    await store.put("clients", "u:i", { ...mapping, syncedNodes: rows.map((row) => row.id) });
    await store.put("inbounds", "i2", { ...inbound, id: "i2", name: "直连联通云盘1", subSortIndex: 2 });
    await store.put("inbound-node-bindings", "i2:js", { inboundId: "i2", nodeId: "js", panelInboundId: 3 });
    await store.put("clients", "u:i2", { ...mapping, id: "u:i2", inboundId: "i2", syncedNodes: ["js"] });
    const clash = (await renderSubscription(store, user, key, "clash")).body;
    const names = ["日本 · 江苏镇江1", "日本 · 陕西西安1", "直连联通云盘1 · 江苏镇江1", "日本 · 日本东京2"];
    const positions = names.map((name) => clash.indexOf(`name: "${name}"`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    const uris = Buffer.from((await renderSubscription(store, user, key, "v2ray")).body, "base64").toString("utf8").split("\n");
    expect(uris.map((uri) => decodeURIComponent(uri.split("#")[1]!))).toEqual(names);
    await store.put("nodes", "xa", { ...node, ...rows[1], sortIndex: 0 });
    const reordered = (await renderSubscription(store, user, key, "clash")).body;
    expect(reordered.indexOf('name: "日本 · 陕西西安1"')).toBeLessThan(reordered.indexOf('name: "日本 · 江苏镇江1"'));
  });
  it("keeps a shared direct inbound distinct from a relay with an exit label", async () => {
    const { store } = await setup();
    await store.put("inbounds", "i", { ...inbound, name: "直连日本东京1" });
    await store.put("nodes", "n", { ...node, name: "日本东京2" });
    await store.put("inbounds", "relay", { ...inbound, id: "relay", name: "中转日本东京2", exitLabel: "日本东京1" });
    await store.put("inbound-node-bindings", "relay:n", { inboundId: "relay", nodeId: "n", panelInboundId: 2 });
    await store.put("clients", "u:relay", { ...mapping, id: "u:relay", inboundId: "relay" });
    const body = (await renderSubscription(store, user, key, "clash")).body;
    expect(body).toContain('name: "直连日本东京1 · 日本东京2"');
    expect(body).toContain('name: "中转日本东京2 · 日本东京1"');
  });
  it("exports WireGuard peers with the server key derived from the panel secret", async () => {
    const wgInbound = {
      ...inbound, protocol: "wireguard", port: 51820, network: "udp",
      config: { settings: { secretKey: "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=", subnetIp: "10.0.0.0", subnetCidr: 24, mtu: 1420 } },
    } as Inbound;
    const wgMapping = {
      ...mapping, wgPrivateKey: "dwdtCnMYpX08FsFyUbJmRd9ML4frwJkqsXf7pR25LCo=",
      wgPublicKey: "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo=", wgAddresses: { n: "10.0.0.2" },
    } as ClientMapping;
    const entry = await convertSubscriptionEntry(wgInbound, node, wgMapping, key);
    expect(entry?.clash).toMatchObject({
      type: "wireguard", server: "edge.example.com", port: 51820, ip: "10.0.0.2",
      "private-key": wgMapping.wgPrivateKey, "public-key": "HIgo9xNzJMWLKASShiTqIybxZ0U3wGLiUeJ1PKf8ykw=",
      "allowed-ips": ["0.0.0.0/0"], mtu: 1420,
    });
    expect(entry?.uri).toContain("wireguard://");
    expect(entry?.uri).toContain("address=10.0.0.2");
    // Without peer credentials, a server key or an address the tunnel cannot be built.
    expect(await convertSubscriptionEntry(wgInbound, node, mapping, key)).toBeNull();
    expect(await convertSubscriptionEntry({ ...wgInbound, config: { settings: { mtu: 1420 } } }, node, wgMapping, key)).toBeNull();
    expect(await convertSubscriptionEntry(wgInbound, node, { ...wgMapping, wgAddresses: {} }, key)).toBeNull();
  });
  it("renders WireGuard peers in the clash profile", async () => {
    const { store } = await setup();
    const wgInbound = {
      ...inbound, protocol: "wireguard", port: 51820, network: "udp",
      config: { settings: { secretKey: "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=", subnetIp: "10.0.0.0", subnetCidr: 24, mtu: 1420 } },
    } as Inbound;
    await store.put("inbounds", "i", wgInbound);
    await store.put("clients", "u:i", {
      ...mapping, wgPrivateKey: "dwdtCnMYpX08FsFyUbJmRd9ML4frwJkqsXf7pR25LCo=",
      wgPublicKey: "hSDwCYkwp1R0i33ctD73Wg2/Og0mOBr066SpjqqbTmo=", wgAddresses: { n: "10.0.0.2" },
    });
    const rendered = await renderSubscription(store, user, key, "clash");
    expect(rendered.count).toBe(1);
    for (const line of ['type: "wireguard"', 'ip: "10.0.0.2"', 'private-key: "dwdtCnMYpX08FsFyUbJmRd9ML4frwJkqsXf7pR25LCo="', 'public-key: "HIgo9xNzJMWLKASShiTqIybxZ0U3wGLiUeJ1PKf8ykw="', 'allowed-ips: ["0.0.0.0/0"]', "mtu: 1420"]) {
      expect(rendered.body).toContain(line);
    }
    // SIP008 has no WireGuard representation, so the entry is reported as skipped instead.
    expect((await renderSubscription(store, user, key, "shadowsocks")).count).toBe(0);
  });
  it("keeps proxy names unique so a duplicate inbound and node pair still loads", async () => {
    const { store } = await setup();
    await store.put("inbounds", "i2", { ...inbound, id: "i2" });
    await store.put("inbound-node-bindings", "i2:n", { inboundId: "i2", nodeId: "n", panelInboundId: 2 });
    await store.put("clients", "u:i2", { ...mapping, id: "u:i2", inboundId: "i2" });

    const body = (await renderSubscription(store, user, key, "clash")).body;
    expect(body).toContain('"日本 · Tokyo"');
    expect(body).toContain('"日本 · Tokyo #2"');
  });
  it("renders an empty clash profile that still points at DIRECT", async () => {
    const { store } = await setup();
    await store.put("clients", "u:i", { ...mapping, enable: false });

    const rendered = await renderSubscription(store, user, key, "clash");
    expect(rendered.count).toBe(0);
    expect(rendered.body).toContain("proxies: []");
    expect(rendered.body).toContain('proxies: ["DIRECT"]');
    expect(rendered.body).not.toContain("♻️ 自动选择\"");
    expect(rendered.body).toContain("MATCH,🐟 漏网之鱼");
  });
  it("serves inbounds bound to the user's current plan and hides the rest", async () => {
    const { store } = await setup();
    await store.put("inbounds", "i", { ...inbound, planIds: ["p"] });
    expect((await renderSubscription(store, user, key, "clash")).count).toBe(1);
    await store.put("inbounds", "i", { ...inbound, planIds: ["other"] });
    expect((await renderSubscription(store, user, key, "clash")).count).toBe(0);
    // Empty or legacy bindings keep the level gate, so a high level alone still qualifies.
    await store.put("inbounds", "i", { ...inbound, planIds: [], minimumLevel: 0 });
    expect((await renderSubscription(store, user, key, "clash")).count).toBe(1);
  });
  it("uses the panel encryption recorded for each node", async () => {
    const { store } = await setup();
    const secondNode = { ...node, id: "n2", name: "Osaka", publicAddress: "edge2.example.com" } as NodeRecord;
    await store.put("nodes", "n2", secondNode);
    await store.put("inbounds", "i", {
      ...inbound,
      config: {
        settings: { decryption: "mlkem-server-key", encryption: "platform-key" },
        streamSettings: { network: "tcp", security: "none" },
      },
    });
    await store.put("clients", "u:i", {
      ...mapping, syncedNodes: ["n", "n2"], nodeEncryption: { n: "mlkem-node-1", n2: "mlkem-node-2" },
    });
    await store.put("inbound-node-bindings", "i:n", { id: "i:n", inboundId: "i", nodeId: "n", panelInboundId: 1 });
    await store.put("inbound-node-bindings", "i:n2", { id: "i:n2", inboundId: "i", nodeId: "n2", panelInboundId: 2 });

    const rendered = await renderSubscription(store, user, key, "clash");
    expect(rendered.count).toBe(2);
    expect(rendered.body).toContain('name: "日本 · Tokyo"');
    expect(rendered.body).toContain('encryption: "mlkem-node-1"');
    expect(rendered.body).toContain('name: "日本 · Osaka"');
    expect(rendered.body).toContain('encryption: "mlkem-node-2"');
    expect(rendered.body).not.toContain('encryption: "platform-key"');
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
    expect(clash.headers.get("cache-control")).toContain("must-revalidate");
    const tag = clash.headers.get("etag");
    expect(tag).toMatch(/^"[0-9a-f]{20}"$/);
    const revalidated = await request(new URL(first.links.clash!).pathname + "?format=clash", { headers: { "If-None-Match": tag! } });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get("etag")).toBe(tag);
    expect(revalidated.headers.get("subscription-userinfo")).toContain("total=");
    expect(await revalidated.text()).toBe("");
    expect((await request(new URL(first.links.clash!).pathname + "?format=clash", { headers: { "If-None-Match": `W/${tag!}` } })).status).toBe(304);
    expect((await request(new URL(first.links.clash!).pathname + "?format=clash", { headers: { "If-None-Match": '"stale"' } })).status).toBe(200);
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
