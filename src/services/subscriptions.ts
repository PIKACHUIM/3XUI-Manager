import { servesPlan } from "../domain/defaults";
import { decryptSecret, encryptSecret, randomToken, sha256 } from "../domain/security";
import type { ClientMapping, Inbound, InboundNodeBinding, NodeRecord, Plan, User } from "../domain/types";
import type { DocumentStore } from "../storage/store";
import { listCollection } from "./xui-sync";

export interface SubscriptionCredential { userId: string; tokenHash: string; encryptedToken: string; updatedAt: string }
export type SubscriptionFormat = "clash" | "v2ray" | "shadowsocks";
export async function subscriptionCredential(store: DocumentStore, userId: string, key: string, reset = false): Promise<{ token: string; updatedAt: string }> {
  const owner = randomToken();
  if (!await store.acquireLease(`subscription:${userId}`, owner, Date.now() + 30000)) throw new Error("Subscription update in progress.");
  try {
    const old = await store.get<SubscriptionCredential>("subscription-credentials", userId);
    if (old && !reset) return { token: await decryptSecret(old.encryptedToken, key), updatedAt: old.updatedAt };
    const token = randomToken(32);
    const record = { userId, tokenHash: await sha256(token), encryptedToken: await encryptSecret(token, key), updatedAt: new Date().toISOString() };
    await store.put("subscription-token-index", record.tokenHash, { userId });
    await store.put("subscription-credentials", userId, record);
    if (old) await store.delete("subscription-token-index", old.tokenHash);
    return { token, updatedAt: record.updatedAt };
  } finally { await store.releaseLease(`subscription:${userId}`, owner); }
}
export async function subscriptionUser(store: DocumentStore, token: string): Promise<User | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const hash = await sha256(token);
  const index = await store.get<{ userId: string }>("subscription-token-index", hash);
  if (!index) return null;
  const current = await store.get<SubscriptionCredential>("subscription-credentials", index.userId);
  if (current?.tokenHash !== hash) return null;
  return store.get<User>("users", index.userId);
}
export async function subscriptionActive(store: DocumentStore, user: User): Promise<boolean> {
  const plan = await store.get<Plan>("plans", user.planId);
  return Boolean(plan?.enabled && user.enabled && user.planTrafficBytes > user.billedBytes && (!user.planExpiresAt || Date.parse(user.planExpiresAt) > Date.now()));
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value === "string") { try { return object(JSON.parse(value)); } catch { return {}; } }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
const text = (v: unknown): string => typeof v === "string" ? v : "";
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
function base64(value: string): string { return btoa(Array.from(new TextEncoder().encode(value), b => String.fromCharCode(b)).join("")); }
/** A share address must be a bare host without scheme, path or port. */
function shareHost(value: string | undefined): string {
  const raw = value?.trim() ?? "";
  const host = raw.replace(/^\[|\]$/g, "");
  if (!host || /[\s/@?#\\]/.test(host) || ["0.0.0.0", "::", "*"].includes(host)) return "";
  try { const parsed = new URL(`https://${host.includes(":") ? `[${host}]` : host}`); return parsed.port ? "" : host; } catch { return ""; }
}
/**
 * The panel's own inbounds usually listen on every interface, so a "listen" strategy with an empty
 * or wildcard address falls back to the node address instead of dropping the inbound from the feed.
 */
function address(inbound: Inbound, node: NodeRecord): string {
  if (inbound.shareAddrStrategy === "custom") return shareHost(inbound.shareAddr);
  if (inbound.shareAddrStrategy === "listen" && shareHost(inbound.listen)) return shareHost(inbound.listen);
  return shareHost(node.publicAddress);
}
interface ProxyEntry { clash: Record<string, unknown>; uri: string; ss?: Record<string, unknown> }
export async function convertSubscriptionEntry(inbound: Inbound, node: NodeRecord, mapping: ClientMapping, key: string): Promise<ProxyEntry | null> {
  const server = address(inbound, node);
  if (!server || !Number.isInteger(inbound.port) || inbound.port < 1 || inbound.port > 65535) return null;
  const protocol = inbound.protocol.toLowerCase();
  if (!["vmess", "vless", "trojan", "shadowsocks"].includes(protocol)) return null;
  const stream = object(inbound.config.streamSettings), settings = object(inbound.config.settings);
  const network = text(stream.network) || inbound.network || "tcp";
  const security = text(stream.security) || "none";
  if (!["tcp", "ws", "grpc"].includes(network) || !["none", "tls", "reality"].includes(security)) return null;
  if (network === "tcp" && text(object(object(stream.tcpSettings).header).type) && object(object(stream.tcpSettings).header).type !== "none") return null;
  if (security === "reality" && (protocol !== "vless" || network !== "tcp")) return null;
  if (protocol === "trojan" && security !== "tls") return null;
  const name = `${inbound.name} · ${node.name} (${inbound.id}/${node.id})`;
  const clash: Record<string, unknown> = { name, type: protocol === "shadowsocks" ? "ss" : protocol, server, port: inbound.port, udp: true };
  const params = new URLSearchParams({ type: network, security });
  let secret = mapping.clientId;
  if (protocol === "trojan") {
    if (!mapping.encryptedSecret) return null;
    try { secret = await decryptSecret(mapping.encryptedSecret, key); } catch { return null; }
    if (!secret) return null;
    clash.password = secret;
  } else if (protocol !== "shadowsocks") {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(secret)) return null;
    clash.uuid = secret;
    if (protocol === "vmess") { clash.alterId = 0; clash.cipher = "auto"; }
    if (protocol === "vless") {
      // VLESS encryption (ML-KEM) is negotiated with the server's decryption string; clients reuse
      // the inbound encryption value verbatim, exactly as the panel's own share links do.
      const decryption = text(settings.decryption);
      if (decryption && decryption !== "none") {
        const encryption = text(settings.encryption);
        if (!encryption || encryption === "none") return null;
        clash.encryption = encryption;
        params.set("encryption", encryption);
      } else {
        params.set("encryption", "none");
      }
      if (mapping.flow) {
        if (mapping.flow !== "xtls-rprx-vision" || network !== "tcp" || security === "none") return null;
        clash.flow = mapping.flow; params.set("flow", mapping.flow);
      }
    }
  }
  let sni = "", alpn: string[] = [];
  if (security === "tls") {
    const tls = object(stream.tlsSettings), client = object(tls.settings);
    sni = text(client.serverName) || text(tls.serverName);
    alpn = strings(tls.alpn);
    clash.tls = true;
    if (sni) { clash[protocol === "trojan" ? "sni" : "servername"] = sni; params.set("sni", sni); }
    if (alpn.length) { clash.alpn = alpn; params.set("alpn", alpn.join(",")); }
    const fingerprint = text(client.fingerprint) || text(tls.fingerprint);
    if (fingerprint) { clash["client-fingerprint"] = fingerprint; params.set("fp", fingerprint); }
  }
  if (security === "reality") {
    const reality = object(stream.realitySettings), client = object(reality.settings);
    const publicKey = text(client.publicKey) || text(reality.publicKey);
    sni = text(client.serverName) || strings(reality.serverNames)[0] || "";
    const shortId = strings(reality.shortIds)[0] ?? text(client.shortId);
    if (!publicKey || !sni || !/^[a-f0-9]{0,16}$/i.test(shortId) || shortId.length % 2) return null;
    const fingerprint = text(client.fingerprint) || "chrome";
    Object.assign(clash, { tls: true, servername: sni, "client-fingerprint": fingerprint, "reality-opts": { "public-key": publicKey, "short-id": shortId } });
    params.set("sni", sni); params.set("pbk", publicKey); params.set("sid", shortId); params.set("fp", fingerprint);
  }
  let path = "", host = "";
  if (network === "ws") {
    const ws = object(stream.wsSettings);
    path = text(ws.path) || "/"; host = text(object(ws.headers).Host) || text(ws.host);
    // Early data and arbitrary request headers need client-specific translation.
    if (ws.maxEarlyData || Object.keys(object(ws.headers)).some(k => k !== "Host")) return null;
    clash.network = "ws"; clash["ws-opts"] = { path, ...(host ? { headers: { Host: host } } : {}) };
    params.set("path", path); if (host) params.set("host", host);
  }
  if (network === "grpc") {
    const grpc = object(stream.grpcSettings);
    if (grpc.multiMode) return null;
    path = text(grpc.serviceName);
    clash.network = "grpc"; clash["grpc-opts"] = { "grpc-service-name": path };
    params.set("serviceName", path);
  }
  const authority = `${server.includes(":") ? `[${server}]` : server}:${inbound.port}`;
  if (protocol === "shadowsocks") {
    if (network !== "tcp" || security !== "none") return null;
    const method = text(settings.method);
    if (!["aes-128-gcm", "aes-256-gcm", "chacha20-ietf-poly1305"].includes(method)) return null;
    const clients = Array.isArray(settings.clients) ? settings.clients.map(object) : [];
    const client = clients.find(c => c.email === mapping.email && c.enable !== false);
    // A per-user password must be explicitly present; never substitute a UUID or panel credential.
    secret = text(client?.password);
    if (!secret) return null;
    clash.cipher = method; clash.password = secret;
    return { clash, uri: `ss://${base64(`${method}:${secret}`)}@${authority}#${encodeURIComponent(name)}`, ss: { id: `${inbound.id}:${node.id}`, remarks: name, server, server_port: inbound.port, method, password: secret } };
  }
  const uri = protocol === "vmess"
    ? `vmess://${base64(JSON.stringify({ v: "2", ps: name, add: server, port: String(inbound.port), id: secret, aid: "0", scy: "auto", net: network, type: "none", host, path, tls: security === "tls" ? "tls" : "", sni, alpn: alpn.join(",") }))}`
    : `${protocol}://${encodeURIComponent(secret)}@${authority}?${params}#${encodeURIComponent(name)}`;
  return { clash, uri };
}
export async function renderSubscription(store: DocumentStore, user: User, key: string, format: SubscriptionFormat): Promise<{ body: string; contentType: string; count: number; skipped: number }> {
  const [inbounds, nodes, bindings, mappings] = await Promise.all([
    listCollection<Inbound>(store, "inbounds"), listCollection<NodeRecord>(store, "nodes"),
    listCollection<InboundNodeBinding>(store, "inbound-node-bindings"), listCollection<ClientMapping>(store, "clients", `${user.id}:`),
  ]);
  const entries: ProxyEntry[] = []; let skipped = 0;
  for (const inbound of inbounds.sort((a, b) => (a.subSortIndex ?? 0) - (b.subSortIndex ?? 0))) {
    if (!servesPlan(inbound, user) || inbound.excludeFromSub || (inbound.expiryTime && inbound.expiryTime <= Date.now())) continue;
    const mapping = mappings.find(m => m.inboundId === inbound.id && m.userId === user.id);
    // A partially synced inbound still serves the nodes that did accept the client; only a mapping
    // with no confirmed node or a disabled client is withheld.
    if (!mapping?.enable || mapping.syncedNodes.length === 0 || (mapping.syncStatus !== "synced" && mapping.syncStatus !== "partial")) continue;
    for (const binding of bindings.filter(b => b.inboundId === inbound.id && b.panelInboundId > 0)) {
      const node = nodes.find(n => n.id === binding.nodeId);
      if (!node?.enabled || !mapping.syncedNodes.includes(node.id)) continue;
      const entry = await convertSubscriptionEntry(inbound, node, mapping, key);
      if (entry && (format !== "shadowsocks" || entry.ss)) entries.push(entry); else skipped++;
    }
  }
  let body: string;
  if (format === "clash") body = JSON.stringify({ proxies: entries.map(e => e.clash), "proxy-groups": [{ name: "Subscription", type: "select", proxies: entries.map(e => e.clash.name) }], rules: ["MATCH,Subscription"] }, null, 2);
  else if (format === "v2ray") body = base64(entries.map(e => e.uri).join("\n"));
  else body = JSON.stringify({ version: 1, servers: entries.map(e => e.ss) }, null, 2);
  return { body, contentType: format === "clash" ? "application/yaml; charset=utf-8" : format === "v2ray" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8", count: entries.length, skipped };
}
