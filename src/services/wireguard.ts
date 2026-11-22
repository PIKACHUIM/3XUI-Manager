import type { ThreeXuiClient } from "../adapters/xui/client";
import type { ClientMapping, Inbound } from "../domain/types";
import { generateWireGuardKeys } from "../domain/wireguard";
import type { DocumentStore } from "../storage/store";

function object(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try { return object(JSON.parse(value)); } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function ipv4ToNumber(value: string): number | null {
  const parts = value.trim().split(".");
  if (parts.length !== 4) return null;
  let total = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    total = total * 256 + octet;
  }
  return total;
}

function numberToIpv4(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].map((part) => String(part)).join(".");
}

/** IPv4 addresses already claimed by peers, from their `allowedIPs` (string or array). */
function claimedAddresses(peers: readonly Record<string, unknown>[]): Set<string> {
  const claimed = new Set<string>();
  for (const peer of peers) {
    for (const host of peerHosts(peer)) claimed.add(host);
  }
  return claimed;
}

function peerHosts(peer: Record<string, unknown>): string[] {
  const allowed: unknown[] = Array.isArray(peer.allowedIPs) ? peer.allowedIPs : String(peer.allowedIPs ?? "").split(",");
  return allowed.flatMap((entry) => {
    if (typeof entry !== "string") return [];
    const host = entry.split("/")[0]?.trim();
    return host && ipv4ToNumber(host) !== null ? [host] : [];
  });
}

interface WireGuardSettings {
  subnetIp: string;
  subnetCidr: number;
  mtu: number;
  peers: Array<Record<string, unknown>>;
}

/** Reads the panel's WireGuard settings, keeping anything we do not manage untouched. */
function readSettings(settings: Record<string, unknown>): WireGuardSettings {
  const subnetIp = typeof settings.subnetIp === "string" && ipv4ToNumber(settings.subnetIp) !== null ? settings.subnetIp.trim() : "10.0.0.0";
  const rawCidr = Number(settings.subnetCidr);
  const subnetCidr = Number.isInteger(rawCidr) && rawCidr >= 8 && rawCidr <= 30 ? rawCidr : 24;
  const rawMtu = Number(settings.mtu);
  const mtu = Number.isInteger(rawMtu) && rawMtu >= 576 && rawMtu <= 1500 ? rawMtu : 1420;
  const peers = Array.isArray(settings.peers) ? settings.peers.map(object) : [];
  return { subnetIp, subnetCidr, mtu, peers };
}

/** Picks the lowest free host address in the panel subnet, starting at .2 like the panel does. */
function allocateAddress(settings: WireGuardSettings, peers: readonly Record<string, unknown>[], preferred?: string): string {
  const base = ipv4ToNumber(settings.subnetIp) ?? ipv4ToNumber("10.0.0.0")!;
  const size = 2 ** (32 - settings.subnetCidr);
  const network = Math.floor(base / size) * size;
  const first = network + 2;
  const last = network + size - 2;
  const claimed = claimedAddresses(peers);
  if (preferred && ipv4ToNumber(preferred) !== null && !claimed.has(preferred)) return preferred;
  for (let candidate = first; candidate <= last && candidate - first < 4096; candidate += 1) {
    const address = numberToIpv4(candidate);
    if (!claimed.has(address)) return address;
  }
  throw new Error("WireGuard subnet is full.");
}

function storedAddress(mapping: ClientMapping, nodeId: string): string {
  return mapping.wgAddresses?.[nodeId]?.trim() ?? "";
}

function storeAddress(mapping: ClientMapping, nodeId: string, address: string): void {
  mapping.wgAddresses = { ...mapping.wgAddresses, [nodeId]: address };
}

/**
 * Peer updates rewrite the whole peer list, so concurrent syncs for the same inbound must not
 * interleave. A plan edit re-syncs every user at once, hence a short bounded wait instead of
 * failing the first caller outright.
 */
async function waitForLease(store: DocumentStore, name: string, owner: string): Promise<boolean> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (await store.acquireLease(name, owner, Date.now() + 20_000)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * Adds, refreshes or removes the account's peer on a WireGuard inbound. The panel keeps one server
 * key per inbound and every client is a peer with its own key pair and tunnel address, so a user
 * gets exactly one peer and one stable address per node. Runs under a per-inbound lease because the
 * update rewrites the peer list read-modify-write.
 */
export async function syncWireGuardPeer(
  store: DocumentStore,
  client: ThreeXuiClient,
  mapping: ClientMapping,
  inbound: Inbound,
  nodeId: string,
  panelInboundId: number,
  eligible: boolean,
): Promise<string> {
  // Nothing was ever provisioned for this account, so a disabled user needs no panel call at all.
  if (!eligible && !mapping.wgPublicKey) return "";
  const lease = `wireguard:${nodeId}:${panelInboundId}`;
  const owner = crypto.randomUUID();
  if (!await waitForLease(store, lease, owner)) throw new Error("WireGuard peer update is busy; retrying on the next sync.");
  try {
    const panel = await client.listInbounds();
    const source = panel.find((item) => item.id === panelInboundId);
    if (!source) throw new Error(`3X-UI inbound ${panelInboundId} was not found.`);
    const raw = object(source.settings);
    const streamSettings = object(source.streamSettings);
    const sniffing = object(source.sniffing);
    const settings = readSettings(raw);
    const peers = settings.peers.map((peer) => ({ ...peer }));
    const savePeers = async (): Promise<void> => {
      await client.updateInbound(panelInboundId, {
        ...inbound,
        config: { ...inbound.config, settings: { ...raw, peers }, streamSettings, sniffing },
      });
    };
    const index = mapping.wgPublicKey ? peers.findIndex((peer) => peer.publicKey === mapping.wgPublicKey) : -1;
    if (!eligible) {
      if (index < 0) return "";
      peers.splice(index, 1);
      await savePeers();
      return "";
    }
    const keys = mapping.wgPrivateKey && mapping.wgPublicKey
      ? { privateKey: mapping.wgPrivateKey, publicKey: mapping.wgPublicKey }
      : generateWireGuardKeys();
    mapping.wgPrivateKey = keys.privateKey;
    mapping.wgPublicKey = keys.publicKey;
    const existing = index >= 0 ? peers[index] : null;
    const retained = existing ? peerHosts(existing)[0] ?? "" : "";
    const address = allocateAddress(settings, peers.filter((_, position) => position !== index), retained || storedAddress(mapping, nodeId));
    storeAddress(mapping, nodeId, address);
    const allowedIPs = [`${address}/32`];
    const keepAlive = typeof existing?.keepAlive === "number" ? existing.keepAlive : 0;
    const peer = { ...(existing ?? {}), publicKey: keys.publicKey, allowedIPs, keepAlive };
    if (index >= 0) peers[index] = peer; else peers.push(peer);
    // Cron ticks re-run this sync for every account, so only touch the panel when the peer differs.
    const unchanged = existing !== null && existing.publicKey === keys.publicKey && existing.keepAlive === keepAlive
      && JSON.stringify(existing.allowedIPs) === JSON.stringify(allowedIPs);
    if (!unchanged) await savePeers();
    return address;
  } finally {
    await store.releaseLease(lease, owner);
  }
}
