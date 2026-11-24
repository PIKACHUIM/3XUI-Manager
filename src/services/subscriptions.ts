import { servesPlan } from "../domain/defaults";
import { decryptSecret, encryptSecret, randomToken, sha256 } from "../domain/security";
import { wireGuardPublicKey } from "../domain/wireguard";
import type { ClientMapping, Inbound, InboundNodeBinding, NodeRecord, Plan, User } from "../domain/types";
import type { DocumentStore } from "../storage/store";
import { D1Store } from "../storage/d1";
import { listCollection } from "./xui-sync";

export interface SubscriptionCredential { userId: string; tokenHash: string; encryptedToken: string; updatedAt: string }
export type SubscriptionFormat = "clash" | "v2ray" | "shadowsocks";
export async function subscriptionCredential(store: DocumentStore, userId: string, key: string, reset = false): Promise<{ token: string; updatedAt: string }> {
  // The common path only reads the token, so it must not take the rotation lease.
  const old = await store.get<SubscriptionCredential>("subscription-credentials", userId);
  if (old && !reset) return { token: await decryptSecret(old.encryptedToken, key), updatedAt: old.updatedAt };
  const owner = randomToken();
  if (!await store.acquireLease(`subscription:${userId}`, owner, Date.now() + 30000)) throw new Error("Subscription update in progress.");
  try {
    const current = await store.get<SubscriptionCredential>("subscription-credentials", userId);
    if (current && !reset) return { token: await decryptSecret(current.encryptedToken, key), updatedAt: current.updatedAt };
    const token = randomToken(32);
    const record = { userId, tokenHash: await sha256(token), encryptedToken: await encryptSecret(token, key), updatedAt: new Date().toISOString() };
    await store.put("subscription-token-index", record.tokenHash, { userId });
    await store.put("subscription-credentials", userId, record);
    if (current) await store.delete("subscription-token-index", current.tokenHash);
    return { token, updatedAt: record.updatedAt };
  } finally { await store.releaseLease(`subscription:${userId}`, owner); }
}
/** The account behind a subscription token plus the plan it is on, resolved together. */
export async function subscriptionAccess(store: DocumentStore, token: string): Promise<{ user: User; plan: Plan | null } | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const hash = await sha256(token);
  if (store instanceof D1Store) return store.readSubscriptionAccess(hash);
  const index = await store.get<{ userId: string }>("subscription-token-index", hash);
  if (!index) return null;
  const [credential, user] = await Promise.all([
    store.get<SubscriptionCredential>("subscription-credentials", index.userId),
    store.get<User>("users", index.userId),
  ]);
  if (credential?.tokenHash !== hash || !user) return null;
  return { user, plan: await store.get<Plan>("plans", user.planId) };
}
export async function subscriptionUser(store: DocumentStore, token: string): Promise<User | null> {
  return (await subscriptionAccess(store, token))?.user ?? null;
}
export function subscriptionIsActive(user: User, plan: Plan | null): boolean {
  return Boolean(plan?.enabled && user.enabled && user.planTrafficBytes > user.billedBytes && (!user.planExpiresAt || Date.parse(user.planExpiresAt) > Date.now()));
}

/** The rows a subscription feed is rendered from. */
export interface SubscriptionSources { inbounds: Inbound[]; nodes: NodeRecord[]; bindings: InboundNodeBinding[]; mappings: ClientMapping[] }
export interface SubscriptionFeed { user: User; plan: Plan | null; sources: SubscriptionSources }

async function loadSubscriptionSources(store: DocumentStore, userId: string): Promise<SubscriptionSources> {
  const [inbounds, nodes, bindings, mappings] = await Promise.all([
    listCollection<Inbound>(store, "inbounds"), listCollection<NodeRecord>(store, "nodes"),
    listCollection<InboundNodeBinding>(store, "inbound-node-bindings"), listCollection<ClientMapping>(store, "clients", `${userId}:`),
  ]);
  return { inbounds, nodes, bindings, mappings };
}

/** Resolves the token and loads the feed in one round trip when the driver can batch it. */
export async function subscriptionFeed(store: DocumentStore, token: string): Promise<SubscriptionFeed | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  if (store instanceof D1Store) {
    const feed = await store.readSubscriptionFeed(await sha256(token));
    if (feed) return feed;
  }
  const access = await subscriptionAccess(store, token);
  if (!access) return null;
  return { ...access, sources: await loadSubscriptionSources(store, access.user.id) };
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
/**
 * Hysteria2 authenticates with the per-client `auth` token (the client id this manager mints) and
 * may wrap the QUIC stream in Salamander obfuscation. Both the Clash entry and the share link must
 * carry the same token and obfs password, otherwise the handshake fails. Hysteria v1 is a different
 * transport and is left out rather than emitted as a broken node.
 */
function hysteriaEntry(inbound: Inbound, mapping: ClientMapping, name: string, server: string, authority: string): ProxyEntry | null {
  const stream = object(inbound.config.streamSettings);
  if (Number(object(stream.hysteriaSettings).version) === 1) return null;
  const tls = object(stream.tlsSettings);
  const sni = text(object(tls.settings).serverName) || text(tls.serverName);
  const masks = Array.isArray(object(stream.finalmask).udp) ? object(stream.finalmask).udp as unknown[] : [];
  const salamander = masks.map((item) => object(item)).find((item) => item.type === "salamander");
  const obfsPassword = salamander ? text(object(salamander.settings).password) : "";
  const password = mapping.clientId;
  if (!password) return null;
  // The panel's certificate is issued for its own hostnames, so the node address rarely matches it.
  const clash: Record<string, unknown> = { name, type: "hysteria2", server, port: inbound.port, password, udp: true, "skip-cert-verify": true };
  const params = new URLSearchParams({ insecure: "1" });
  if (sni) { clash.sni = sni; params.set("sni", sni); }
  if (obfsPassword) {
    clash.obfs = "salamander";
    clash["obfs-password"] = obfsPassword;
    params.set("obfs", "salamander");
    params.set("obfs-password", obfsPassword);
  }
  return { clash, uri: `hysteria2://${encodeURIComponent(password)}@${authority}?${params}#${encodeURIComponent(name)}` };
}
export async function convertSubscriptionEntry(inbound: Inbound, node: NodeRecord, mapping: ClientMapping, key: string, displayName?: string): Promise<ProxyEntry | null> {
  const server = address(inbound, node);
  if (!server || !Number.isInteger(inbound.port) || inbound.port < 1 || inbound.port > 65535) return null;
  const protocol = inbound.protocol.toLowerCase();
  if (!["vmess", "vless", "trojan", "shadowsocks", "wireguard", "hysteria", "hysteria2"].includes(protocol)) return null;
  const name = displayName?.trim() || `${inbound.name} · ${node.name} (${inbound.id}/${node.id})`;
  const authority = `${server.includes(":") ? `[${server}]` : server}:${inbound.port}`;
  if (protocol === "hysteria" || protocol === "hysteria2") return hysteriaEntry(inbound, mapping, name, server, authority);
  if (protocol === "wireguard") {
    const wg = object(inbound.config.settings);
    const peerPrivateKey = text(mapping.wgPrivateKey);
    const serverSecretKey = text(wg.secretKey);
    const peerAddress = text(mapping.wgAddresses?.[node.id]);
    // The panel stores only the server secret; clients authenticate the server with its public key.
    if (!peerPrivateKey || !serverSecretKey || !peerAddress) return null;
    let serverPublicKey: string;
    try { serverPublicKey = wireGuardPublicKey(serverSecretKey); } catch { return null; }
    const rawMtu = Number(wg.mtu);
    const mtu = Number.isInteger(rawMtu) && rawMtu >= 576 && rawMtu <= 1500 ? rawMtu : 1420;
    const params = new URLSearchParams({ publickey: serverPublicKey, address: peerAddress, mtu: String(mtu) });
    return {
      clash: {
        name, type: "wireguard", server, port: inbound.port, ip: peerAddress,
        "private-key": peerPrivateKey, "public-key": serverPublicKey, "allowed-ips": ["0.0.0.0/0"], udp: true, mtu,
      },
      uri: `wireguard://${encodeURIComponent(peerPrivateKey)}@${authority}?${params}#${encodeURIComponent(name)}`,
    };
  }
  const stream = object(inbound.config.streamSettings), settings = object(inbound.config.settings);
  const network = text(stream.network) || inbound.network || "tcp";
  const security = text(stream.security) || "none";
  if (!["tcp", "ws", "grpc"].includes(network) || !["none", "tls", "reality"].includes(security)) return null;
  if (network === "tcp" && text(object(object(stream.tcpSettings).header).type) && object(object(stream.tcpSettings).header).type !== "none") return null;
  if (security === "reality" && (protocol !== "vless" || network !== "tcp")) return null;
  if (protocol === "trojan" && security !== "tls") return null;
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
/** Serialises a plain object tree as YAML; JSON quoting keeps every string valid in double-quoted YAML. */
function yamlScalar(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
function yamlLines(value: unknown, indent: number): string[] {
  const pad = "  ".repeat(indent);
  const inline = (items: unknown[]) => items.every((item) => !item || typeof item !== "object") && items.map(yamlScalar).join(", ").length <= 80;
  if (Array.isArray(value)) {
    if (!value.length) return [`${pad}[]`];
    if (inline(value)) return [`${pad}[${value.map(yamlScalar).join(", ")}]`];
    return value.map((item) => {
      if (!item || typeof item !== "object") return `${pad}- ${yamlScalar(item)}`;
      const lines = yamlLines(item, indent + 1);
      return [`${pad}- ${(lines[0] ?? "").trimStart()}`, ...lines.slice(1)].join("\n");
    });
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return [`${pad}{}`];
    return entries.flatMap(([key, child]) => {
      const label = /^[A-Za-z0-9_.-]+$/.test(key) ? key : JSON.stringify(key);
      if (Array.isArray(child) && inline(child)) return [`${pad}${label}: [${child.map(yamlScalar).join(", ")}]`];
      if (child && typeof child === "object") return [`${pad}${label}:`, ...yamlLines(child, indent + 1)];
      return [`${pad}${label}: ${yamlScalar(child)}`];
    });
  }
  return [`${pad}${yamlScalar(value)}`];
}

const CLASH_AUTO = "♻️ 自动选择";
const CLASH_HEALTH_URL = "http://cp.cloudflare.com/generate_204";
type ClashCategoryTarget = "proxy" | "direct" | "reject";
/** Rule categories; every group lists the nodes itself so the node choice stays manual. */
const clashCategories: Array<[string, ClashCategoryTarget]> = [
  ["🎬 爱奇艺&哔哩哔哩", "direct"],
  ["📺 动画疯", "proxy"],
  ["🎮 Steam 登录/下载", "direct"],
  ["🛒 Steam 商店/社区", "proxy"],
  ["☁️ Cloudflare", "proxy"],
  ["📁 OneDrive", "proxy"],
  ["🎓 学术网站", "proxy"],
  ["🇨🇳 国内网站", "direct"],
  ["🛑 拦截广告", "reject"],
  ["🐟 漏网之鱼", "proxy"],
];
const clashCategory = (suffix: string) => clashCategories.find(([name]) => name.includes(suffix))?.[0] ?? "";
const clashRules: string[] = [
  "DOMAIN-SUFFIX,local,DIRECT", "DOMAIN-SUFFIX,lan,DIRECT",
  "IP-CIDR,127.0.0.0/8,DIRECT,no-resolve", "IP-CIDR,10.0.0.0/8,DIRECT,no-resolve", "IP-CIDR,172.16.0.0/12,DIRECT,no-resolve",
  "IP-CIDR,192.168.0.0/16,DIRECT,no-resolve", "IP-CIDR,100.64.0.0/10,DIRECT,no-resolve", "IP-CIDR,224.0.0.0/4,DIRECT,no-resolve",
  "IP-CIDR6,fe80::/10,DIRECT,no-resolve",
  ...[
    "doubleclick.net", "googlesyndication.com", "googleadservices.com", "adservice.google.com", "adcolony.com",
    "applovin.com", "unityads.unity3d.com", "umeng.com", "cnzz.com", "hm.baidu.com", "adnxs.com", "adsrvr.org",
    "criteo.com", "taboola.com", "outbrain.com", "ads.youtube.com", "ads.twitter.com",
  ].map((domain) => `DOMAIN-SUFFIX,${domain},${clashCategory("拦截广告")}`),
  ...[
    "iqiyi.com", "iq.com", "bilibili.com", "bilivideo.com", "biliapi.net", "hdslb.com",
  ].map((domain) => `DOMAIN-SUFFIX,${domain},${clashCategory("爱奇艺")}`),
  `DOMAIN-KEYWORD,bilibili,${clashCategory("爱奇艺")}`,
  ...[ "bahamut.com.tw", "gamer.com.tw" ].map((domain) => `DOMAIN-SUFFIX,${domain},${clashCategory("动画疯")}`),
  `DOMAIN-KEYWORD,bahamut,${clashCategory("动画疯")}`,
  ...[ "steamcontent.com", "steamstatic.com", "steamcdn-a.akamaihd.net" ].map((domain) => `DOMAIN-SUFFIX,${domain},${clashCategory("Steam 登录")}`),
  ...[ "steampowered.com", "steamcommunity.com", "steamusercontent.com" ].map((domain) => `DOMAIN-SUFFIX,${domain},${clashCategory("Steam 商店")}`),
  ...[ "cloudflare.com", "cloudflare-dns.com", "cloudflareclient.com", "workers.dev", "cloudflarestream.com" ].map((domain) => `DOMAIN-SUFFIX,${domain},${clashCategory("Cloudflare")}`),
  ...[ "onedrive.com", "onedrive.live.com", "1drv.com", "1drv.ms", "sharepoint.com" ].map((domain) => `DOMAIN-SUFFIX,${domain},${clashCategory("OneDrive")}`),
  ...[
    "scholar.google.com", "arxiv.org", "nature.com", "science.org", "sciencedirect.com", "springer.com",
    "ieee.org", "acm.org", "researchgate.net", "jstor.org", "semanticscholar.org", "mdpi.com", "webofscience.com",
  ].map((domain) => `DOMAIN-SUFFIX,${domain},${clashCategory("学术网站")}`),
  `DOMAIN-KEYWORD,sci-hub,${clashCategory("学术网站")}`,
  ...[ "baidu.com", "taobao.com", "jd.com", "weixin.qq.com", "alicdn.com", "126.net", "cn" ].map((domain) => `DOMAIN-SUFFIX,${domain},${clashCategory("国内网站")}`),
  `GEOIP,CN,${clashCategory("国内网站")}`,
  `MATCH,${clashCategory("漏网之鱼")}`,
];
const clashDns = {
  enable: true,
  ipv6: false,
  "enhanced-mode": "fake-ip",
  "fake-ip-range": "198.18.0.1/16",
  "fake-ip-filter": ["*.lan", "*.local", "*.localdomain", "localhost.ptlogin2.qq.com", "+.msftconnecttest.com", "+.msftncsi.com"],
  "default-nameserver": ["223.5.5.5", "119.29.29.29"],
  nameserver: ["https://doh.pub/dns-query", "https://dns.alidns.com/dns-query"],
  fallback: ["https://1.1.1.1/dns-query", "https://8.8.8.8/dns-query"],
  "fallback-filter": { geoip: true, "geoip-code": "CN", ipcidr: ["240.0.0.0/4"] },
};
/** Category options start from the default target, then every node, so the user can switch by hand. */
function categoryProxies(target: ClashCategoryTarget, names: readonly string[]): string[] {
  const nodes = [...names, ...(names.length ? [CLASH_AUTO] : [])];
  if (target === "reject") return ["REJECT", "DIRECT", ...nodes];
  if (target === "direct") return ["DIRECT", ...nodes];
  return [...(names.length ? [CLASH_AUTO] : []), ...names, "DIRECT"];
}
/**
 * A full Clash / Mihomo profile: general options, fake-ip DNS, the proxies and the rule categories.
 * Only the url-test group is generated besides the categories; node choice inside each category is
 * manual, so no selector, fallback or region group is created.
 */
function renderClashConfig(proxies: Array<Record<string, unknown>>): string {
  const names = proxies.map((proxy) => String(proxy.name));
  const groups: Array<Record<string, unknown>> = [];
  if (names.length) groups.push({ name: CLASH_AUTO, type: "url-test", url: CLASH_HEALTH_URL, interval: 300, tolerance: 50, proxies: [...names] });
  for (const [name, target] of clashCategories) groups.push({ name, type: "select", proxies: categoryProxies(target, names) });
  const config = {
    "mixed-port": 7890,
    "allow-lan": false,
    mode: "rule",
    "log-level": "info",
    ipv6: false,
    "external-controller": "127.0.0.1:9090",
    dns: clashDns,
    proxies,
    "proxy-groups": groups,
    rules: clashRules,
  };
  return ["# 3XUI Manager · Clash / Mihomo 订阅配置", ...yamlLines(config, 0)].join("\n") + "\n";
}
export async function renderSubscription(store: DocumentStore, user: User, key: string, format: SubscriptionFormat): Promise<{ body: string; contentType: string; count: number; skipped: number }> {
  return renderSubscriptionFeed(user, await loadSubscriptionSources(store, user.id), key, format);
}
/** Renders a feed from already loaded rows, so a request never waits on more than one D1 round trip. */
export async function renderSubscriptionFeed(user: User, sources: SubscriptionSources, key: string, format: SubscriptionFormat): Promise<{ body: string; contentType: string; count: number; skipped: number }> {
  const { inbounds, nodes, bindings, mappings } = sources;
  const entries: ProxyEntry[] = []; let skipped = 0;
  const usedNames = new Set<string>(clashCategories.map(([name]) => name));
  for (const inbound of inbounds.sort((a, b) => (a.subSortIndex ?? 0) - (b.subSortIndex ?? 0))) {
    if (!servesPlan(inbound, user) || inbound.excludeFromSub || (inbound.expiryTime && inbound.expiryTime <= Date.now())) continue;
    const mapping = mappings.find(m => m.inboundId === inbound.id && m.userId === user.id);
    // A partially synced inbound still serves the nodes that did accept the client; only a mapping
    // with no confirmed node or a disabled client is withheld.
    if (!mapping?.enable || mapping.syncedNodes.length === 0 || (mapping.syncStatus !== "synced" && mapping.syncStatus !== "partial")) continue;
    for (const binding of bindings.filter(b => b.inboundId === inbound.id && b.panelInboundId > 0)) {
      const node = nodes.find(n => n.id === binding.nodeId);
      if (!node?.enabled || !mapping.syncedNodes.includes(node.id)) continue;
      const base = `${inbound.name} · ${node.name}`;
      let name = base;
      for (let suffix = 2; usedNames.has(name); suffix += 1) name = `${base} #${suffix}`;
      usedNames.add(name);
      const entry = await convertSubscriptionEntry(inbound, node, mapping, key, name);
      if (entry && (format !== "shadowsocks" || entry.ss)) entries.push(entry); else skipped++;
    }
  }
  let body: string;
  if (format === "clash") body = renderClashConfig(entries.map((entry) => entry.clash));
  else if (format === "v2ray") body = base64(entries.map((entry) => entry.uri).join("\n"));
  else body = JSON.stringify({ version: 1, servers: entries.map((entry) => entry.ss) }, null, 2);
  return { body, contentType: format === "clash" ? "application/yaml; charset=utf-8" : format === "v2ray" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8", count: entries.length, skipped };
}
