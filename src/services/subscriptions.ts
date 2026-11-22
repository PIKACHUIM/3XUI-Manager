import { servesPlan } from "../domain/defaults";
import { decryptSecret, encryptSecret, randomToken, sha256 } from "../domain/security";
import { wireGuardPublicKey } from "../domain/wireguard";
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
export async function convertSubscriptionEntry(inbound: Inbound, node: NodeRecord, mapping: ClientMapping, key: string, displayName?: string): Promise<ProxyEntry | null> {
  const server = address(inbound, node);
  if (!server || !Number.isInteger(inbound.port) || inbound.port < 1 || inbound.port > 65535) return null;
  const protocol = inbound.protocol.toLowerCase();
  if (!["vmess", "vless", "trojan", "shadowsocks", "wireguard"].includes(protocol)) return null;
  const name = displayName?.trim() || `${inbound.name} · ${node.name} (${inbound.id}/${node.id})`;
  const authority = `${server.includes(":") ? `[${server}]` : server}:${inbound.port}`;
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

const CLASH_SELECT = "🚀 节点选择";
const CLASH_AUTO = "♻️ 自动选择";
const CLASH_FALLBACK = "🚑 故障转移";
const CLASH_HEALTH_URL = "http://cp.cloudflare.com/generate_204";
const clashRegionGroup = (region: string) => `📍 ${region}`;
/** Category groups and their initially selected target, mirroring common Clash rule sets. */
const clashCategories: Array<[string, string]> = [
  ["🎬 爱奇艺&哔哩哔哩", "DIRECT"],
  ["📺 动画疯", CLASH_SELECT],
  ["🎮 Steam 登录/下载", "DIRECT"],
  ["🛒 Steam 商店/社区", CLASH_SELECT],
  ["☁️ Cloudflare", CLASH_SELECT],
  ["📁 OneDrive", CLASH_SELECT],
  ["🎓 学术网站", CLASH_SELECT],
  ["🇨🇳 国内网站", "DIRECT"],
  ["🛑 拦截广告", "REJECT"],
  ["🐟 漏网之鱼", CLASH_SELECT],
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
/**
 * A full Clash / Mihomo profile: general options, fake-ip DNS, the proxies, a select/url-test/fallback
 * stack with region groups, and the usual rule categories so the profile works without a converter.
 */
function renderClashConfig(entries: Array<{ proxy: Record<string, unknown>; region: string }>): string {
  const proxies = entries.map((entry) => entry.proxy);
  const names = proxies.map((proxy) => String(proxy.name));
  const regions = new Map<string, string[]>();
  entries.forEach((entry, index) => {
    if (!entry.region || names.includes(entry.region)) return;
    regions.set(entry.region, [...(regions.get(entry.region) ?? []), names[index] ?? ""]);
  });
  const regionGroups = [...regions.entries()].filter(([, members]) => members.length > 1);
  const groups: Array<Record<string, unknown>> = [
    { name: CLASH_SELECT, type: "select", proxies: names.length ? [CLASH_AUTO, CLASH_FALLBACK, ...regionGroups.map(([region]) => clashRegionGroup(region)), ...names, "DIRECT"] : ["DIRECT"] },
  ];
  if (names.length) {
    groups.push({ name: CLASH_AUTO, type: "url-test", url: CLASH_HEALTH_URL, interval: 300, tolerance: 50, proxies: [...names] });
    groups.push({ name: CLASH_FALLBACK, type: "fallback", url: CLASH_HEALTH_URL, interval: 300, proxies: [...names] });
  }
  for (const [region, members] of regionGroups) groups.push({ name: clashRegionGroup(region), type: "select", proxies: [...members, "DIRECT"] });
  for (const [name, selected] of clashCategories) {
    const options = selected === "REJECT" ? ["REJECT", "DIRECT", CLASH_SELECT] : selected === CLASH_SELECT ? [CLASH_SELECT, "DIRECT"] : ["DIRECT", CLASH_SELECT];
    groups.push({ name, type: "select", proxies: options });
  }
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
  const [inbounds, nodes, bindings, mappings] = await Promise.all([
    listCollection<Inbound>(store, "inbounds"), listCollection<NodeRecord>(store, "nodes"),
    listCollection<InboundNodeBinding>(store, "inbound-node-bindings"), listCollection<ClientMapping>(store, "clients", `${user.id}:`),
  ]);
  const entries: Array<{ entry: ProxyEntry; region: string }> = []; let skipped = 0;
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
      if (entry && (format !== "shadowsocks" || entry.ss)) entries.push({ entry, region: text(node.region).trim() }); else skipped++;
    }
  }
  let body: string;
  if (format === "clash") body = renderClashConfig(entries.map(({ entry, region }) => ({ proxy: entry.clash, region })));
  else if (format === "v2ray") body = base64(entries.map(({ entry }) => entry.uri).join("\n"));
  else body = JSON.stringify({ version: 1, servers: entries.map(({ entry }) => entry.ss) }, null, 2);
  return { body, contentType: format === "clash" ? "application/yaml; charset=utf-8" : format === "v2ray" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8", count: entries.length, skipped };
}
