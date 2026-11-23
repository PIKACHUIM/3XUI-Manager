import type { RuntimeEnv } from "../../env";
import type { ClientMapping, Inbound, InboundNodeBinding, NodeRecord, User } from "../../domain/types";
import { decryptSecret } from "../../domain/security";

interface XuiEnvelope<T> {
  success?: boolean;
  msg?: string;
  obj?: T;
  /** Raw body kept when the panel answered with something other than JSON. */
  raw?: string;
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

/**
 * Workers refuse to connect to an IP literal and Cloudflare answers 403 "error code: 1003",
 * so an IPv4 panel is fetched through nip.io, which resolves the same address under a hostname.
 */
function fetchableOrigin(url: URL): URL {
  const octets = url.hostname.split(".");
  const isIpv4 = octets.length === 4 && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  if (!isIpv4) return url;
  const rewritten = new URL(url.toString());
  rewritten.hostname = `${url.hostname}.nip.io`;
  return rewritten;
}

/** Replays every cookie the panel set on login, in the shape a browser would send back. */
function readSessionCookie(response: Response): string | null {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const entries = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [response.headers.get("set-cookie") ?? ""];
  const pairs = entries.map((entry) => entry.split(";")[0]?.trim() ?? "").filter((entry) => entry.includes("="));
  return pairs.length ? pairs.join("; ") : null;
}

/** Explains a failed panel call, including status and content type when the body carries no message. */
function describePanelFailure(response: Response, payload: XuiEnvelope<unknown>): string {
  const status = `HTTP ${response.status}`;
  if (typeof payload.msg === "string" && payload.msg && payload.msg !== "non-JSON response") return `${payload.msg.slice(0, 180)} (${status})`;
  const type = response.headers.get("content-type")?.split(";")[0]?.trim() || "no content-type";
  const body = payload.raw?.replace(/\s+/g, " ").trim().slice(0, 120) ?? "";
  const edge = /error code:\s*(52\d)/i.exec(body)?.[1];
  const hint = edge === "520" || edge === "525" || edge === "526"
    ? " — Cloudflare reached this host but the plain HTTP reply came back empty; serve the panel over HTTPS, for example through a Cloudflare Tunnel"
    : edge
      ? " — Cloudflare never reached the panel; check its firewall for blocked Cloudflare ranges or expose it through a Cloudflare Tunnel"
      : "";
  return `${status}, ${type}${body ? `: ${body}` : ""}${hint}`;
}

/** True when an endpoint answered with a rendered page instead of the panel's JSON API. */
function servedMarkup(payload: XuiEnvelope<unknown>): boolean {
  return typeof payload.obj === "string" && /^\s*<(!doctype|html|head|body)/i.test(payload.obj);
}

const WRONG_ADDRESS = "This address serves a web page, not the 3X-UI API; use the panel address such as http://host:2053.";

/**
 * Workers cannot open a connection to an IP literal, so Cloudflare answers such a fetch with
 * 403 "error code: 1003". A hostname that resolves to the same address works normally.
 */
function describesBareIpBlock(response: Response, payload: XuiEnvelope<unknown>): boolean {
  return response.status === 403 && typeof payload.raw === "string" && /error code:\s*1003/i.test(payload.raw);
}

const BARE_IP_BLOCKED = "Cloudflare Workers cannot fetch a bare IP address. Point a DNS record at the panel (for example panel.example.com) and use that hostname instead of the IP.";

/**
 * fetch() rejects with a bare "operation was aborted" when the origin never answers,
 * which hides which address was tried and why it failed.
 */
function describeNetworkFailure(error: unknown, target: URL, seconds: number): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (/timeout|abort/i.test(detail)) {
    return `no response from ${target.host} within ${seconds}s — the host is dropping Cloudflare's connection; check its firewall or serve the panel through a Cloudflare Tunnel`;
  }
  return `${target.host}: ${detail}`;
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
  private csrf: string | null = null;
  private panelServesMarkup = false;

  private constructor(private readonly env: RuntimeEnv, private readonly node: NodeRecord, private readonly password: string, private readonly token: string | null) {
    this.origin = fetchableOrigin(validatePanelUrl(node.panelUrl));
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
    await this.login();
  }

  /**
   * 3X-UI binds the login body either as a form or as JSON depending on the build,
   * so send the form encoding first and fall back to JSON when the panel answers success:false.
   * Builds from 2.6 on also require a CSRF token bound to the session cookie, otherwise
   * `/login` answers with an empty 403 instead of JSON.
   */
  private async login(): Promise<void> {
    this.panelServesMarkup = false;
    await this.refreshCsrf();
    if (this.panelServesMarkup) throw new Error(`3X-UI login failed: ${WRONG_ADDRESS}`);
    const attempts: Array<[string, string]> = [
      ["application/x-www-form-urlencoded", new URLSearchParams({ username: this.node.username, password: this.password }).toString()],
      ["application/json", JSON.stringify({ username: this.node.username, password: this.password })],
    ];
    const errors: string[] = [];
    let csrfRetried = false;
    for (const [contentType, body] of attempts) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let response: Response;
        const loginUrl = new URL(`${this.basePath()}/login`, this.origin);
        try {
          const headers = new Headers({ "Content-Type": contentType, Accept: "application/json", "X-Requested-With": "XMLHttpRequest" });
          if (this.cookie) headers.set("Cookie", this.cookie);
          if (this.csrf) headers.set("X-CSRF-Token", this.csrf);
          response = await fetch(loginUrl, { method: "POST", headers, body, signal: AbortSignal.timeout(12000) });
        } catch (error) {
          errors.push(describeNetworkFailure(error, loginUrl, 12));
          break;
        }
        const cookie = readSessionCookie(response);
        const payload = await this.readEnvelope<unknown>(response);
        if (describesBareIpBlock(response, payload)) throw new Error(`3X-UI login failed: ${BARE_IP_BLOCKED}`);
        if (response.ok && payload.success !== false) {
          if (servedMarkup(payload)) {
            this.panelServesMarkup = true;
            throw new Error(`3X-UI login failed: ${WRONG_ADDRESS}`);
          }
          if (cookie) this.cookie = cookie;
          if (!this.cookie) throw new Error("3X-UI accepted the login but returned no session cookie; configure an API token for this node.");
          await this.refreshCsrf();
          return;
        }
        if (response.status === 403 && !csrfRetried) {
          csrfRetried = true;
          await this.refreshCsrf();
          continue;
        }
        errors.push(describePanelFailure(response, payload));
        break;
      }
    }
    throw new Error(`3X-UI login failed: ${[...new Set(errors)].join(" / ") || "unknown error"}`);
  }

  /** Fetches the CSRF token newer panels bind to the session cookie; older panels simply have no such endpoint. */
  private async refreshCsrf(): Promise<void> {
    try {
      const headers = new Headers({ Accept: "application/json", "X-Requested-With": "XMLHttpRequest" });
      if (this.cookie) headers.set("Cookie", this.cookie);
      const response = await fetch(new URL(`${this.basePath()}/csrf-token`, this.origin), { headers, signal: AbortSignal.timeout(12000) });
      if (!response.ok) return;
      const cookie = readSessionCookie(response);
      if (cookie) this.cookie = cookie;
      const payload = await this.readEnvelope<string>(response);
      if (servedMarkup(payload)) {
        this.panelServesMarkup = true;
        return;
      }
      if (typeof payload.obj === "string" && payload.obj) this.csrf = payload.obj;
    } catch {
      this.csrf = null;
    }
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<XuiEnvelope<T>> {
    const target = new URL(`${this.basePath()}${path}`, this.origin);
    const send = async (): Promise<Response> => {
      const headers = new Headers(init.headers);
      headers.set("Accept", "application/json");
      headers.set("X-Requested-With", "XMLHttpRequest");
      if (this.bearer) headers.set("Authorization", `Bearer ${this.bearer}`);
      if (this.cookie) headers.set("Cookie", this.cookie);
      if (!this.bearer && this.csrf) headers.set("X-CSRF-Token", this.csrf);
      try {
        return await fetch(target, { ...init, headers, signal: AbortSignal.timeout(15000) });
      } catch (error) {
        throw new Error(`3X-UI request failed: ${describeNetworkFailure(error, target, 15)}`);
      }
    };
    let response = await send();
    if (!response.ok && this.password) {
      if (this.bearer && (response.status === 401 || response.status === 403)) {
        this.bearer = null;
        this.cookie = null;
        this.csrf = null;
        await this.login();
        response = await send();
      } else if (!this.bearer && response.status === 401) {
        this.cookie = null;
        this.csrf = null;
        await this.login();
        response = await send();
      } else if (!this.bearer && response.status === 403) {
        await this.refreshCsrf();
        response = await send();
      }
    }
    const payload = await this.readEnvelope<T>(response);
    if (describesBareIpBlock(response, payload)) throw new Error(`3X-UI request failed: ${BARE_IP_BLOCKED}`);
    if (servedMarkup(payload)) throw new Error(`3X-UI request failed: ${WRONG_ADDRESS}`);
    if (!response.ok || payload.success === false) {
      throw new Error(`3X-UI request failed: ${describePanelFailure(response, payload)}`);
    }
    return payload;
  }

  private async readEnvelope<T>(response: Response): Promise<XuiEnvelope<T>> {
    const raw = await response.text();
    try {
      return JSON.parse(raw) as XuiEnvelope<T>;
    } catch {
      if (response.ok) return { success: true, obj: raw as T, raw };
      return { success: false, msg: "non-JSON response", raw };
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

  /** Asks the panel to mint VLESS encryption key pairs, the same call behind 3X-UI's Generate keys button. */
  async newVlessEnc(): Promise<Array<{ decryption: string; encryption: string; label?: string; id?: string }>> {
    const response = await this.request<{ auths?: Array<{ decryption?: unknown; encryption?: unknown; label?: unknown; id?: unknown }> }>("/panel/api/server/getNewVlessEnc");
    const auths = Array.isArray(response.obj?.auths) ? response.obj.auths : [];
    const items = auths.flatMap((auth) => typeof auth?.decryption === "string" && typeof auth.encryption === "string" && auth.decryption && auth.encryption
      ? [{ decryption: auth.decryption, encryption: auth.encryption, ...(typeof auth.label === "string" ? { label: auth.label } : {}), ...(typeof auth.id === "string" ? { id: auth.id } : {}) }]
      : []);
    if (!items.length) throw new Error("3X-UI returned no VLESS encryption keys.");
    return items;
  }

  async upsertClient(mapping: ClientMapping, inbound: Inbound, binding: InboundNodeBinding, user: User): Promise<void> {
    const id = mapping.clientId;
    const enable = mapping.enable && user.enabled && user.billedBytes < user.planTrafficBytes;
    // 3X-UI keeps this legacy "totalGB" field in bytes, so the plan quota is sent as-is.
    const quota = {
      email: mapping.email,
      enable,
      totalGB: Math.max(0, Math.ceil(user.planTrafficBytes)),
      expiryTime: user.planExpiresAt ? Date.parse(user.planExpiresAt) : 0,
      limitIp: 0,
      reset: 0,
    };
    // The panel only exposes the client as a path parameter; `?email=` answers 404 and used to
    // leave every existing client on its creation-time quota.
    try {
      await this.request(`/panel/api/clients/update/${encodeURIComponent(mapping.email)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...quota, flow: mapping.flow }),
      });
      return;
    } catch (error) {
      if (!(error instanceof Error) || !/(record not found|not found)/i.test(error.message)) throw error;
    }
    const client: XuiClientData = { id, ...quota, flow: mapping.flow, subId: id.replaceAll("-", "").slice(0, 16) };
    if (inbound.protocol.toLowerCase() === "trojan" && mapping.encryptedSecret && this.env.APP_ENCRYPTION_KEY) {
      client.password = await decryptSecret(mapping.encryptedSecret, this.env.APP_ENCRYPTION_KEY);
    }
    await this.request("/panel/api/clients/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client, inboundIds: [binding.panelInboundId] }),
    });
  }

  async disableClient(mapping: ClientMapping): Promise<void> {
    await this.request(`/panel/api/clients/update/${encodeURIComponent(mapping.email)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: mapping.email, enable: false }),
    });
  }

  async deleteClient(mapping: ClientMapping): Promise<void> {
    await this.request(`/panel/api/clients/del/${encodeURIComponent(mapping.email)}?keepTraffic=1`, { method: "POST" });
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
