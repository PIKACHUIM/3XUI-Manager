import type { RuntimeEnv } from "../../env";
import type { ClientMapping, Inbound, InboundNodeBinding, NodeRecord, User } from "../../domain/types";
import { decryptSecret } from "../../domain/security";

interface XuiEnvelope<T> {
  success?: boolean;
  msg?: string;
  obj?: T;
}

export interface XuiInbound {
  id: number;
  remark?: string;
  protocol?: string;
  port?: number;
  enable?: boolean;
  listen?: string;
  total?: number;
  expiryTime?: number;
  trafficReset?: string;
  trafficResetDay?: number;
  tag?: string;
  shareAddrStrategy?: string;
  shareAddr?: string;
  subSortIndex?: number;
  excludeFromSub?: boolean;
  disableFlow?: boolean;
  nodeId?: number | null;
  settings?: unknown;
  streamSettings?: unknown;
  sniffing?: unknown;
  clientStats?: Array<{ email?: string; up?: number; down?: number; total?: number; enable?: boolean }>;
}

export interface XuiClientData {
  id: string;
  email: string;
  enable: boolean;
  totalGB: number;
  expiryTime: number;
  flow: string;
  limitIp: number;
  subId: string;
  reset: number;
  [key: string]: string | number | boolean;
}

export function validatePanelUrl(input: string): URL {
  const url = new URL(input);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("3X-UI panel URL must use HTTP or HTTPS.");
  if (url.username || url.password) throw new Error("Do not embed panel credentials in the URL.");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal") || hostname === "metadata.google.internal") {
    throw new Error("Panel URL cannot target a local or internal hostname.");
  }
  const ipv4 = hostname.split(".").map(Number);
  if (ipv4.length === 4 && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [a, b] = ipv4;
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (a === 100 && b! >= 64 && b! <= 127)) {
      throw new Error("Panel URL cannot target a private, loopback, or link-local IP address.");
    }
  }
  if (hostname === "::" || hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe80:")) {
    throw new Error("Panel URL cannot target a private or loopback IPv6 address.");
  }
  return url;
}

/** Builds the 3X-UI add/update payload, keeping unknown top-level config keys. */
export function inboundPayload(inbound: Inbound): Record<string, unknown> {
  const { settings, streamSettings, sniffing, ...extra } = inbound.config;
  return {
    ...extra,
    up: 0,
    down: 0,
    total: inbound.total ?? 0,
    remark: inbound.name,
    enable: inbound.enabled,
    expiryTime: inbound.expiryTime ?? 0,
    listen: inbound.listen ?? "",
    port: inbound.port,
    protocol: inbound.protocol,
    settings: settings ?? { clients: [] },
    streamSettings: streamSettings ?? {},
    sniffing: sniffing ?? {},
    trafficReset: inbound.trafficReset ?? "never",
    trafficResetDay: inbound.trafficResetDay ?? 0,
    subSortIndex: inbound.subSortIndex ?? 1,
    shareAddrStrategy: inbound.shareAddrStrategy ?? "node",
    excludeFromSub: inbound.excludeFromSub === true,
    disableFlow: inbound.disableFlow === true,
    ...(inbound.tag ? { tag: inbound.tag } : {}),
    ...(inbound.shareAddr ? { shareAddr: inbound.shareAddr } : {}),
  };
}

export class ThreeXuiClient {
  private readonly origin: URL;
  private cookie: string | null = null;
  private bearer: string | null = null;

  private constructor(private readonly env: RuntimeEnv, private readonly node: NodeRecord, private readonly password: string, private readonly token: string | null) {
    this.origin = validatePanelUrl(node.panelUrl);
  }

  static async connect(env: RuntimeEnv, node: NodeRecord): Promise<ThreeXuiClient> {
    if (!env.APP_ENCRYPTION_KEY) throw new Error("APP_ENCRYPTION_KEY is required to access node credentials.");
    const password = await decryptSecret(node.encryptedPassword, env.APP_ENCRYPTION_KEY);
    const token = node.apiTokenEncrypted ? await decryptSecret(node.apiTokenEncrypted, env.APP_ENCRYPTION_KEY) : null;
    const client = new ThreeXuiClient(env, node, password, token);
    await client.authenticate();
    return client;
  }

  private basePath(): string {
    const path = this.node.basePath.trim();
    const clean = path === "/" ? "" : `/${path.replace(/^\/+|\/+$/g, "")}`;
    return clean;
  }

  private async authenticate(): Promise<void> {
    if (this.token) {
      this.bearer = this.token;
      return;
    }
    const response = await fetch(new URL(`${this.basePath()}/login`, this.origin), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ username: this.node.username, password: this.password }),
      signal: AbortSignal.timeout(8000),
    });
    const cookie = response.headers.get("set-cookie");
    if (cookie) this.cookie = cookie.split(";")[0] ?? null;
    const payload = await this.readEnvelope<unknown>(response);
    if (!response.ok || payload.success === false || (!this.cookie && response.status === 401)) throw new Error(`3X-UI login failed (HTTP ${response.status}).`);
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<XuiEnvelope<T>> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (this.bearer) headers.set("Authorization", `Bearer ${this.bearer}`);
    if (this.cookie) headers.set("Cookie", this.cookie);
    const response = await fetch(new URL(`${this.basePath()}${path}`, this.origin), { ...init, headers, signal: AbortSignal.timeout(10000) });
    const payload = await this.readEnvelope<T>(response);
    if (!response.ok || payload.success === false) {
      throw new Error(`3X-UI request failed (HTTP ${response.status}): ${(payload.msg ?? "panel returned an error").slice(0, 180)}`);
    }
    return payload;
  }

  private async readEnvelope<T>(response: Response): Promise<XuiEnvelope<T>> {
    const raw = await response.text();
    try {
      return JSON.parse(raw) as XuiEnvelope<T>;
    } catch {
      if (response.ok) return { success: true, obj: raw as T };
      return { success: false, msg: "non-JSON response" };
    }
  }

  async listInbounds(): Promise<XuiInbound[]> {
    const response = await this.request<XuiInbound[]>("/panel/api/inbounds/list");
    if (!Array.isArray(response.obj)) throw new Error("3X-UI returned an unexpected inbound list.");
    return response.obj;
  }

  readClientUsage(inbounds: readonly XuiInbound[], panelInboundId: number): Map<string, number> {
    const inbound = inbounds.find((item) => item.id === panelInboundId);
    if (!inbound) throw new Error(`3X-UI inbound ${panelInboundId} was not found while sampling traffic.`);
    if (!Array.isArray(inbound.clientStats)) throw new Error(`3X-UI inbound ${panelInboundId} did not include client traffic counters.`);
    const usage = new Map<string, number>();
    for (const stat of inbound.clientStats) {
      if (!stat.email || !Number.isSafeInteger(stat.up) || !Number.isSafeInteger(stat.down) || stat.up! < 0 || stat.down! < 0) {
        throw new Error(`3X-UI inbound ${panelInboundId} returned an invalid client traffic counter.`);
      }
      const total = stat.up! + stat.down!;
      if (!Number.isSafeInteger(total) || usage.has(stat.email)) throw new Error(`3X-UI inbound ${panelInboundId} returned ambiguous client traffic counters.`);
      usage.set(stat.email, total);
    }
    return usage;
  }

  async addInbound(inbound: Inbound): Promise<number> {
    const before = new Set((await this.listInbounds()).map((item) => item.id));
    await this.request("/panel/api/inbounds/add", { method: "POST", headers: { "Content-Type": "application/json" }, body: this.inboundBody(inbound) });
    const after = await this.listInbounds();
    const created = after.find((item) => !before.has(item.id) && item.port === inbound.port);
    if (!created) throw new Error("3X-UI did not return the newly created inbound ID.");
    return created.id;
  }

  async updateInbound(panelInboundId: number, inbound: Inbound): Promise<void> {
    await this.request(`/panel/api/inbounds/update/${panelInboundId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...JSON.parse(this.inboundBody(inbound)) as Record<string, unknown>, id: panelInboundId }),
    });
  }

  async deleteInbound(panelInboundId: number): Promise<void> {
    await this.request(`/panel/api/inbounds/del/${panelInboundId}`, { method: "POST" });
  }

  private inboundBody(inbound: Inbound): string {
    return JSON.stringify(inboundPayload(inbound));
  }

  async supportsClientApi(): Promise<boolean> {
    try {
      const response = await this.request<unknown>("/panel/api/clients/list");
      return response.success !== false;
    } catch (error) {
      if (error instanceof Error && error.message.includes("HTTP 404")) return false;
      throw error;
    }
  }

  async upsertClient(mapping: ClientMapping, inbound: Inbound, binding: InboundNodeBinding, user: User): Promise<void> {
    const id = mapping.clientId;
    const client: XuiClientData = {
      id,
      email: mapping.email,
      enable: mapping.enable && user.enabled && user.billedBytes < user.planTrafficBytes,
      totalGB: Math.max(0, Math.ceil(user.planTrafficBytes / 1_000_000_000)),
      expiryTime: user.planExpiresAt ? Date.parse(user.planExpiresAt) : 0,
      flow: mapping.flow,
      limitIp: 0,
      subId: id.replaceAll("-", "").slice(0, 16),
      reset: 0,
    };
    if (inbound.protocol.toLowerCase() === "trojan" && mapping.encryptedSecret && this.env.APP_ENCRYPTION_KEY) {
      client.password = await decryptSecret(mapping.encryptedSecret, this.env.APP_ENCRYPTION_KEY);
    }
    const body = JSON.stringify({ client, inboundIds: [binding.panelInboundId] });
    const added = await this.tryRequest("/panel/api/clients/add", { method: "POST", headers: { "Content-Type": "application/json" }, body });
    if (added) return;
    await this.request(`/panel/api/clients/update?email=${encodeURIComponent(mapping.email)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...client, inboundIds: [binding.panelInboundId] }),
    });
  }

  async disableClient(mapping: ClientMapping): Promise<void> {
    await this.request(`/panel/api/clients/update?email=${encodeURIComponent(mapping.email)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: mapping.email, enable: false }),
    });
  }

  async deleteClient(mapping: ClientMapping): Promise<void> {
    await this.request(`/panel/api/clients/del/${encodeURIComponent(mapping.email)}?keepTraffic=1`, { method: "POST" });
  }

  private async tryRequest(path: string, init: RequestInit): Promise<boolean> {
    try {
      await this.request(path, init);
      return true;
    } catch (error) {
      if (error instanceof Error && /(exists|already|duplicate)/i.test(error.message)) return false;
      throw error;
    }
  }
}

export async function probeNode(env: RuntimeEnv, node: NodeRecord): Promise<{ status: "online" | "offline"; inbounds: number; clientApi: boolean; checkedAt: string; error?: string }> {
  const checkedAt = new Date().toISOString();
  try {
    const client = await ThreeXuiClient.connect(env, node);
    const inbounds = await client.listInbounds();
    const clientApi = await client.supportsClientApi();
    return { status: "online", inbounds: inbounds.length, clientApi, checkedAt };
  } catch (error) {
    return { status: "offline", inbounds: 0, clientApi: false, checkedAt, error: error instanceof Error ? error.message : "Connection failed." };
  }
}
