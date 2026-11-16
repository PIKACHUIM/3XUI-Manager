export type InboundFieldMap = Record<string, string | boolean>;

export type InboundConfigRecord = {
  name: string;
  protocol: string;
  network: string;
  port: number;
  minimumLevel: number;
  multiplier: number;
  enabled: boolean;
  planEnabled?: boolean;
  config: Record<string, unknown>;
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
  defaultFlow?: string;
};

export type InboundMeta = {
  listen: string;
  total: number;
  expiryTime: number;
  trafficReset: string;
  trafficResetDay: number;
  tag: string;
  shareAddrStrategy: string;
  shareAddr: string;
  subSortIndex: number;
  excludeFromSub: boolean;
  disableFlow: boolean;
  defaultFlow: string;
};

export function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function jsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return plainObject(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  return plainObject(value);
}

export function plainText(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return fallback;
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export const inboundSniffTargets = ["http", "tls", "quic", "fakedns"] as const;
export const inboundProtocols = ["vless", "vmess", "trojan", "shadowsocks", "dokodemo-door", "http", "socks", "mixed", "wireguard"] as const;
export const inboundNetworks = ["tcp", "raw", "ws", "http", "httpupgrade", "grpc", "xhttp", "kcp", "hysteria"] as const;
export const trafficResetUnits = ["never", "hourly", "daily", "weekly", "monthly"] as const;
export const shareAddrStrategies = ["node", "listen", "custom"] as const;
export const tlsVersions = ["1.0", "1.1", "1.2", "1.3"] as const;
export const certificateUsages = ["encipherment", "verify", "issue"] as const;
export const tproxyModes = ["off", "redirect", "tproxy"] as const;
export const domainStrategies = ["AsIs", "UseIP", "UseIPv4", "UseIPv6"] as const;
export const kcpHeaderTypes = ["none", "srtp", "utp", "wechat-video", "dtls", "wireguard"] as const;
export const xhttpModes = ["auto", "packet-up", "stream-up", "stream-one"] as const;

const text = (fields: InboundFieldMap, key: string): string => {
  const value = fields[key];
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  return "";
};

const rawText = (fields: InboundFieldMap, key: string): string => typeof fields[key] === "string" ? fields[key] as string : "";

const flag = (fields: InboundFieldMap, key: string): boolean => fields[key] === true;

function number(fields: InboundFieldMap, key: string, fallback: number, minimum = Number.NEGATIVE_INFINITY, maximum = Number.POSITIVE_INFINITY): number {
  const source = text(fields, key);
  if (!source) return fallback;
  const value = Number(source);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function list(fields: InboundFieldMap, key: string, allowed?: readonly string[]): string[] {
  return text(fields, key).split(/[,\n]/).map((item) => item.trim()).filter((item) => item.length > 0 && (!allowed || allowed.includes(item)));
}

function jsonValue(fields: InboundFieldMap, key: string): unknown {
  const source = rawText(fields, key).trim();
  if (!source) return undefined;
  try {
    return JSON.parse(source) as unknown;
  } catch {
    return undefined;
  }
}

/** Accepts either a JSON object/array in the field or falls back to the stored value. */
function jsonField(fields: InboundFieldMap, key: string, fallback: unknown): unknown {
  if (!(key in fields)) return fallback;
  const value = jsonValue(fields, key);
  return value === undefined ? fallback : value;
}

function merged(fields: InboundFieldMap, key: string, target: Record<string, unknown>): Record<string, unknown> {
  const extra = jsonValue(fields, key);
  return extra && typeof extra === "object" && !Array.isArray(extra) ? { ...target, ...extra as Record<string, unknown> } : target;
}

const protocolFallbackKeys = new Set([
  "clients", "fallbacks", "decryption", "method", "password", "network", "address", "port", "followRedirect",
  "timeout", "accounts", "allowTransparent", "userLevel", "auth", "udp", "ip", "secretKey", "mtu", "peers",
  "noise", "noKernelTun",
]);

/** Rebuilds a 3X-UI protocol `settings` object from the structured form. */
function buildSettings(fields: InboundFieldMap, protocol: string, baseSettings: Record<string, unknown>): Record<string, unknown> {
  const clients = Array.isArray(baseSettings.clients) ? baseSettings.clients : [];
  const storedFallbacks = Array.isArray(baseSettings.fallbacks) ? baseSettings.fallbacks : [];
  const settings: Record<string, unknown> = Object.fromEntries(Object.entries(baseSettings).filter(([key]) => !protocolFallbackKeys.has(key)));

  if (protocol === "vless" || protocol === "vmess" || protocol === "trojan" || protocol === "shadowsocks") settings.clients = clients;
  if (protocol === "vless") {
    settings.decryption = text(fields, "vlessDecryption") || "none";
    const fallbacks = jsonField(fields, "protocolFallbacks", storedFallbacks);
    if (Array.isArray(fallbacks) && fallbacks.length) settings.fallbacks = fallbacks;
  }
  if (protocol === "trojan") {
    const fallbacks = jsonField(fields, "protocolFallbacks", storedFallbacks);
    if (Array.isArray(fallbacks) && fallbacks.length) settings.fallbacks = fallbacks;
  }
  if (protocol === "shadowsocks") {
    settings.method = text(fields, "ssMethod") || "2022-blake3-aes-128-gcm";
    settings.password = rawText(fields, "ssPassword");
    settings.network = text(fields, "ssNetwork") || "tcp,udp";
  }
  if (protocol === "dokodemo-door") {
    settings.address = text(fields, "dokodemoAddress");
    settings.port = Math.round(number(fields, "dokodemoPort", 0, 0, 65535));
    settings.network = text(fields, "dokodemoNetwork") || "tcp";
    if (flag(fields, "dokodemoFollowRedirect")) settings.followRedirect = true;
    settings.timeout = Math.round(number(fields, "dokodemoTimeout", 300, 0));
  }
  if (protocol === "http" || protocol === "socks" || protocol === "mixed") {
    const accounts = jsonField(fields, "protocolAccounts", Array.isArray(baseSettings.accounts) ? baseSettings.accounts : []);
    settings.auth = text(fields, "proxyAuth") || "noauth";
    settings.accounts = Array.isArray(accounts) ? accounts : [];
    if (protocol !== "http") settings.udp = flag(fields, "proxyUdp");
    if (protocol === "http") {
      settings.allowTransparent = flag(fields, "httpAllowTransparent");
      settings.userLevel = Math.round(number(fields, "httpUserLevel", 0, 0));
    } else {
      const ip = text(fields, "proxyIp");
      if (ip) settings.ip = ip;
    }
  }
  if (protocol === "wireguard") {
    settings.secretKey = text(fields, "wireguardSecretKey");
    settings.address = list(fields, "wireguardAddress");
    settings.mtu = Math.round(number(fields, "wireguardMtu", 1420, 0, 65535));
    const peers = jsonField(fields, "wireguardPeers", Array.isArray(baseSettings.peers) ? baseSettings.peers : []);
    settings.peers = Array.isArray(peers) ? peers : [];
    const noise = jsonField(fields, "wireguardNoise", baseSettings.noise ?? {});
    if (noise && typeof noise === "object") settings.noise = noise;
    settings.noKernelTun = flag(fields, "wireguardNoKernelTun");
  }
  return merged(fields, "settingsExtra", settings);
}

const managedStreamKeys = new Set([
  "network", "security", "tlsSettings", "realitySettings", "tcpSettings", "rawSettings", "wsSettings", "grpcSettings",
  "httpupgradeSettings", "httpSettings", "kcpSettings", "xhttpSettings", "hysteriaSettings", "sockopt", "tcpMasks", "udpMasks",
]);

function transportSettings(fields: InboundFieldMap, network: string): { key: string; value: Record<string, unknown> } | null {
  if (network === "tcp" || network === "raw") {
    const header: Record<string, unknown> = { type: text(fields, "tcpHeader") || "none" };
    if (header.type === "http") {
      const request = jsonValue(fields, "tcpRequest");
      const response = jsonValue(fields, "tcpResponse");
      if (request && typeof request === "object") header.request = request;
      if (response && typeof response === "object") header.response = response;
    }
    return { key: `${network}Settings`, value: { acceptProxyProtocol: flag(fields, "tcpAcceptProxyProtocol"), header } };
  }
  if (network === "ws") {
    const headers = jsonObject(jsonValue(fields, "wsHeaders"));
    const host = text(fields, "wsHost");
    const settings: Record<string, unknown> = {
      acceptProxyProtocol: flag(fields, "wsAcceptProxyProtocol"),
      path: text(fields, "wsPath") || "/",
      headers: { ...(host ? { Host: host } : {}), ...headers },
    };
    const maxEarlyData = Math.round(number(fields, "wsMaxEarlyData", 0, 0));
    if (maxEarlyData) settings.maxEarlyData = maxEarlyData;
    const earlyDataHeader = text(fields, "wsEarlyDataHeaderName");
    if (earlyDataHeader) settings.earlyDataHeaderName = earlyDataHeader;
    const heartbeat = Math.round(number(fields, "wsHeartbeatPeriod", 0, 0));
    if (heartbeat) settings.heartbeatPeriod = heartbeat;
    return { key: "wsSettings", value: settings };
  }
  if (network === "http") {
    const settings: Record<string, unknown> = {
      host: list(fields, "h2Host"),
      path: text(fields, "h2Path") || "/",
      method: text(fields, "h2Method") || "PUT",
      headers: jsonObject(jsonValue(fields, "h2Headers")),
    };
    const readIdleTimeout = Math.round(number(fields, "h2ReadIdleTimeout", 0, 0));
    if (readIdleTimeout) settings.readIdleTimeout = readIdleTimeout;
    const healthCheckTimeout = Math.round(number(fields, "h2HealthCheckTimeout", 0, 0));
    if (healthCheckTimeout) settings.healthCheckTimeout = healthCheckTimeout;
    return { key: "httpSettings", value: settings };
  }
  if (network === "httpupgrade") {
    return {
      key: "httpupgradeSettings",
      value: {
        acceptProxyProtocol: flag(fields, "upgradeAcceptProxyProtocol"),
        path: text(fields, "upgradePath") || "/",
        host: text(fields, "upgradeHost"),
        headers: jsonObject(jsonValue(fields, "upgradeHeaders")),
      },
    };
  }
  if (network === "grpc") {
    const settings: Record<string, unknown> = {
      serviceName: text(fields, "grpcService"),
      authority: text(fields, "grpcAuthority"),
      multiMode: flag(fields, "grpcMultiMode"),
    };
    const idleTimeout = Math.round(number(fields, "grpcIdleTimeout", 0, 0));
    if (idleTimeout) settings.idle_timeout = idleTimeout;
    const healthCheckTimeout = Math.round(number(fields, "grpcHealthCheckTimeout", 0, 0));
    if (healthCheckTimeout) settings.health_check_timeout = healthCheckTimeout;
    if (flag(fields, "grpcPermitWithoutStream")) settings.permit_without_stream = true;
    const windows = Math.round(number(fields, "grpcInitialWindowsSize", 0, 0));
    if (windows) settings.initial_windows_size = windows;
    return { key: "grpcSettings", value: settings };
  }
  if (network === "xhttp") {
    const settings: Record<string, unknown> = {
      path: text(fields, "xhttpPath") || "/",
      host: text(fields, "xhttpHost"),
      mode: text(fields, "xhttpMode") || "auto",
    };
    const headers = jsonObject(jsonValue(fields, "xhttpHeaders"));
    if (Object.keys(headers).length) settings.headers = headers;
    const xPaddingBytes = text(fields, "xhttpXPaddingBytes");
    const maxBuffered = Math.round(number(fields, "xhttpScMaxBufferedPosts", 0, 0));
    const maxEachPost = Math.round(number(fields, "xhttpScMaxEachPostBytes", 0, 0));
    const xmux: Record<string, unknown> = {};
    const maxConcurrency = Math.round(number(fields, "xhttpMaxConcurrency", 0, 0));
    if (maxConcurrency) xmux.maxConcurrency = maxConcurrency;
    const maxConnections = Math.round(number(fields, "xhttpMaxConnections", 0, 0));
    if (maxConnections) xmux.maxConnections = maxConnections;
    const maxReuseTimes = Math.round(number(fields, "xhttpCMaxReuseTimes", 0, 0));
    if (maxReuseTimes) xmux.cMaxReuseTimes = maxReuseTimes;
    const maxRequestTimes = Math.round(number(fields, "xhttpHMaxRequestTimes", 0, 0));
    if (maxRequestTimes) xmux.hMaxRequestTimes = maxRequestTimes;
    const keepAlivePeriod = Math.round(number(fields, "xhttpHKeepAlivePeriod", 0, 0));
    if (keepAlivePeriod) xmux.hKeepAlivePeriod = keepAlivePeriod;
    const maxLifetime = Math.round(number(fields, "xhttpMaxLifetime", 0, 0));
    if (maxLifetime) xmux.maxLifetime = maxLifetime;
    const extra: Record<string, unknown> = {};
    if (xPaddingBytes) extra.xPaddingBytes = xPaddingBytes;
    if (maxBuffered) extra.scMaxBufferedPosts = maxBuffered;
    if (maxEachPost) extra.scMaxEachPostBytes = maxEachPost;
    if (flag(fields, "xhttpNoGRPCHeader")) extra.noGRPCHeader = true;
    if (Object.keys(xmux).length) extra.xmux = xmux;
    if (Object.keys(extra).length) settings.extra = extra;
    return { key: "xhttpSettings", value: settings };
  }
  if (network === "kcp") {
    const settings: Record<string, unknown> = {
      mtu: Math.round(number(fields, "kcpMtu", 1350, 576, 1460)),
      tti: Math.round(number(fields, "kcpTti", 20, 10, 100)),
      uplinkCapacity: Math.round(number(fields, "kcpUplinkCapacity", 5, 0)),
      downlinkCapacity: Math.round(number(fields, "kcpDownlinkCapacity", 20, 0)),
      cwndMultiplier: number(fields, "kcpCwndMultiplier", 1, 0),
      maxSendingWindow: Math.round(number(fields, "kcpMaxSendingWindow", 2097152, 0)),
      header: { type: text(fields, "kcpHeaderType") || "none" },
    };
    if (flag(fields, "kcpCongestion")) settings.congestion = true;
    const readBufferSize = Math.round(number(fields, "kcpReadBufferSize", 0, 0));
    if (readBufferSize) settings.readBufferSize = readBufferSize;
    const writeBufferSize = Math.round(number(fields, "kcpWriteBufferSize", 0, 0));
    if (writeBufferSize) settings.writeBufferSize = writeBufferSize;
    const seed = text(fields, "kcpSeed");
    if (seed) settings.seed = seed;
    return { key: "kcpSettings", value: settings };
  }
  if (network === "hysteria") {
    const masquerade = jsonValue(fields, "hysteriaMasquerade");
    return {
      key: "hysteriaSettings",
      value: {
        version: Math.round(number(fields, "hysteriaVersion", 2, 1, 2)),
        auth: text(fields, "hysteriaAuth"),
        udpIdleTimeout: Math.round(number(fields, "hysteriaUdpIdleTimeout", 60, 0)),
        masquerade: masquerade && typeof masquerade === "object" ? masquerade : {},
      },
    };
  }
  return null;
}

function buildCertificates(fields: InboundFieldMap): Array<Record<string, unknown>> {
  const override = jsonValue(fields, "tlsCertificates");
  if (Array.isArray(override) && override.length) return override.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  const certificateFile = text(fields, "tlsCertFile");
  const keyFile = text(fields, "tlsKeyFile");
  const certificate = rawText(fields, "tlsCertPem").split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  const key = rawText(fields, "tlsKeyPem").split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  const entry: Record<string, unknown> = {};
  if (certificateFile || keyFile) {
    if (certificateFile) entry.certificateFile = certificateFile;
    if (keyFile) entry.keyFile = keyFile;
  } else if (certificate.length || key.length) {
    entry.useFile = false;
    if (certificate.length) entry.certificate = certificate;
    if (key.length) entry.key = key;
  } else {
    return [];
  }
  const usage = text(fields, "tlsCertUsage");
  if (usage) entry.usage = usage;
  if (flag(fields, "tlsCertOcspStapling")) entry.ocspStapling = true;
  if (flag(fields, "tlsCertOneTimeLoading")) entry.oneTimeLoading = true;
  if (flag(fields, "tlsCertBuildChain")) entry.buildChain = true;
  return [entry];
}

function buildTls(fields: InboundFieldMap): Record<string, unknown> {
  const tls: Record<string, unknown> = { serverName: text(fields, "tlsSni") };
  const alpn = list(fields, "tlsAlpn");
  if (alpn.length) tls.alpn = alpn;
  const cipherSuites = list(fields, "tlsCipherSuites");
  if (cipherSuites.length) tls.cipherSuites = cipherSuites;
  const minVersion = text(fields, "tlsMinVersion");
  if (minVersion) tls.minVersion = minVersion;
  const maxVersion = text(fields, "tlsMaxVersion");
  if (maxVersion) tls.maxVersion = maxVersion;
  const fingerprint = text(fields, "tlsFingerprint");
  if (fingerprint) tls.fingerprint = fingerprint;
  const curves = list(fields, "tlsCurves");
  if (curves.length) tls.curves = curves;
  if (flag(fields, "tlsRejectUnknownSni")) tls.rejectUnknownSni = true;
  if (flag(fields, "tlsDisableSystemRoot")) tls.disableSystemRoot = true;
  const sessionResumption = text(fields, "tlsSessionResumption");
  if (sessionResumption) tls.sessionResumption = sessionResumption;
  const masterKeyLog = text(fields, "tlsMasterKeyLog");
  if (masterKeyLog) tls.masterKeyLog = masterKeyLog;
  const echSockopt = jsonValue(fields, "tlsEchSockopt");
  if (echSockopt && typeof echSockopt === "object" && !Array.isArray(echSockopt)) tls.echSockopt = echSockopt;
  tls.certificates = buildCertificates(fields);
  return tls;
}

function buildReality(fields: InboundFieldMap): Record<string, unknown> {
  const serverNames = list(fields, "realitySni");
  const settings: Record<string, unknown> = {
    show: flag(fields, "realityShow"),
    xver: Math.round(number(fields, "realityXver", 0, 0, 2)),
    dest: text(fields, "realityDest"),
    serverNames,
    privateKey: text(fields, "realityPrivateKey"),
  };
  const minClientVer = text(fields, "realityMinClientVer");
  if (minClientVer) settings.minClientVer = minClientVer;
  const maxClientVer = text(fields, "realityMaxClientVer");
  if (maxClientVer) settings.maxClientVer = maxClientVer;
  const maxTimediff = Math.round(number(fields, "realityMaxTimediff", 0, 0));
  if (maxTimediff) settings.maxTimediff = maxTimediff;
  settings.shortIds = list(fields, "realityShortIds");
  const mldsa65Seed = text(fields, "realityMldsa65Seed");
  if (mldsa65Seed) settings.mldsa65Seed = mldsa65Seed;
  const mldsa65Verify = text(fields, "realityMldsa65Verify");
  if (mldsa65Verify) settings.mldsa65Verify = mldsa65Verify;
  settings.settings = {
    publicKey: text(fields, "realityPublicKey"),
    fingerprint: text(fields, "realityFingerprint") || "chrome",
    serverName: serverNames[0] ?? "",
    spiderX: text(fields, "realitySpiderX") || "/",
  };
  return settings;
}

function buildSockopt(fields: InboundFieldMap): Record<string, unknown> | null {
  const sockopt: Record<string, unknown> = {};
  if (flag(fields, "sockTcpFastOpen")) sockopt.tcpFastOpen = true;
  if (flag(fields, "sockTcpNoDelay")) sockopt.tcpNoDelay = true;
  if (flag(fields, "sockTcpMptcp")) sockopt.tcpMptcp = true;
  const congestion = text(fields, "sockTcpCongestion");
  if (congestion) sockopt.tcpcongestion = congestion;
  const keepAliveIdle = Math.round(number(fields, "sockTcpKeepAliveIdle", 0, 0));
  if (keepAliveIdle) sockopt.tcpKeepAliveIdle = keepAliveIdle;
  const keepAliveInterval = Math.round(number(fields, "sockTcpKeepAliveInterval", 0, 0));
  if (keepAliveInterval) sockopt.tcpKeepAliveInterval = keepAliveInterval;
  const userTimeout = Math.round(number(fields, "sockTcpUserTimeout", 0, 0));
  if (userTimeout) sockopt.tcpUserTimeout = userTimeout;
  const windowClamp = Math.round(number(fields, "sockTcpWindowClamp", 0, 0));
  if (windowClamp) sockopt.tcpWindowClamp = windowClamp;
  const maxSeg = Math.round(number(fields, "sockTcpMaxSeg", 0, 0));
  if (maxSeg) sockopt.tcpMaxSeg = maxSeg;
  const tproxy = text(fields, "sockTproxy");
  if (tproxy && tproxy !== "off" && (tproxyModes as readonly string[]).includes(tproxy)) sockopt.tproxy = tproxy;
  const domainStrategy = text(fields, "sockDomainStrategy");
  if (domainStrategy) sockopt.domainStrategy = domainStrategy;
  const dialerProxy = text(fields, "sockDialerProxy");
  if (dialerProxy) sockopt.dialerProxy = dialerProxy;
  const iface = text(fields, "sockInterface");
  if (iface) sockopt.interface = iface;
  const mark = Math.round(number(fields, "sockMark", 0, 0));
  if (mark) sockopt.mark = mark;
  const happyEyeballs: Record<string, unknown> = {};
  const tryDelayMs = Math.round(number(fields, "sockHappyEyeballsTryDelayMs", 0, 0));
  if (tryDelayMs) happyEyeballs.tryDelayMs = tryDelayMs;
  if (flag(fields, "sockHappyEyeballsPrioritizeIPv4")) happyEyeballs.prioritizeIPv4 = true;
  if (flag(fields, "sockHappyEyeballsInterleave")) happyEyeballs.interleave = true;
  const maxConcurrentTry = Math.round(number(fields, "sockHappyEyeballsMaxConcurrentTry", 0, 0));
  if (maxConcurrentTry) happyEyeballs.maxConcurrentTry = maxConcurrentTry;
  if (Object.keys(happyEyeballs).length) sockopt.happyEyeballs = happyEyeballs;
  const custom = jsonValue(fields, "sockCustomSockopt");
  if (Array.isArray(custom) && custom.length) sockopt.customSockopt = custom;
  return Object.keys(sockopt).length ? sockopt : null;
}

function buildSniffing(fields: InboundFieldMap): Record<string, unknown> {
  const destOverride = list(fields, "sniffDest", inboundSniffTargets);
  const sniffing: Record<string, unknown> = {
    enabled: flag(fields, "sniffEnabled"),
    destOverride,
    metadataOnly: flag(fields, "sniffMetadataOnly"),
    routeOnly: flag(fields, "sniffRouteOnly"),
  };
  const domainsExcluded = list(fields, "sniffDomainsExcluded");
  if (domainsExcluded.length) sniffing.domainsExcluded = domainsExcluded;
  const ipsExcluded = list(fields, "sniffIpsExcluded");
  if (ipsExcluded.length) sniffing.ipsExcluded = ipsExcluded;
  return sniffing;
}

/** Rebuilds the 3X-UI settings/streamSettings/sniffing payload from the structured form. */
export function buildInboundConfig(fields: InboundFieldMap): Record<string, unknown> {
  const base = jsonObject(rawText(fields, "baseConfig") || "{}");
  const baseStream = jsonObject(base.streamSettings);
  const protocol = text(fields, "protocol").toLowerCase();
  const network = text(fields, "network").toLowerCase();
  const security = text(fields, "security").toLowerCase();

  const extras = Object.fromEntries(Object.entries(baseStream).filter(([key]) => !managedStreamKeys.has(key)));
  const streamSettings: Record<string, unknown> = { ...extras, network, security };
  const transport = transportSettings(fields, network);
  if (transport) streamSettings[transport.key] = transport.value;
  if (security === "tls") streamSettings.tlsSettings = buildTls(fields);
  if (security === "reality") streamSettings.realitySettings = buildReality(fields);
  const sockopt = buildSockopt(fields);
  if (sockopt) streamSettings.sockopt = sockopt;
  const tcpMasks = jsonField(fields, "tcpMasks", baseStream.tcpMasks);
  if (Array.isArray(tcpMasks) && tcpMasks.length) streamSettings.tcpMasks = tcpMasks;
  const udpMasks = jsonField(fields, "udpMasks", baseStream.udpMasks);
  if (Array.isArray(udpMasks) && udpMasks.length) streamSettings.udpMasks = udpMasks;

  return {
    settings: buildSettings(fields, protocol, plainObject(base.settings)),
    streamSettings,
    sniffing: buildSniffing(fields),
  };
}

/** Converts the inbound-level fields 3X-UI keeps outside settings/streamSettings/sniffing. */
export function buildInboundMeta(fields: InboundFieldMap): InboundMeta {
  const gigabytes = number(fields, "totalGb", 0, 0);
  const total = Math.round(gigabytes * 1_000_000_000);
  const expiry = text(fields, "expiryTime");
  const parsedExpiry = expiry ? Date.parse(expiry) : Number.NaN;
  const strategy = text(fields, "shareAddrStrategy");
  return {
    listen: text(fields, "listen"),
    total: Number.isSafeInteger(total) && total > 0 ? total : 0,
    expiryTime: Number.isFinite(parsedExpiry) && parsedExpiry > 0 ? Math.round(parsedExpiry) : 0,
    trafficReset: (trafficResetUnits as readonly string[]).includes(text(fields, "trafficReset")) ? text(fields, "trafficReset") : "never",
    trafficResetDay: Math.round(number(fields, "trafficResetDay", 0, 0, 31)),
    tag: text(fields, "tag"),
    shareAddrStrategy: (shareAddrStrategies as readonly string[]).includes(strategy) ? strategy : "node",
    shareAddr: text(fields, "shareAddr"),
    subSortIndex: Math.round(number(fields, "subSortIndex", 1, 0, 9999)),
    excludeFromSub: flag(fields, "excludeFromSub"),
    disableFlow: flag(fields, "disableFlow"),
    defaultFlow: text(fields, "clientFlow"),
  };
}

function localDateTime(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return "";
  const date = new Date(epochMs);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function compactJson(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value) && value.length === 0) return "";
  if (typeof value === "object" && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0) return "";
  return JSON.stringify(value);
}

/** Maps a stored inbound back onto the structured form fields. */
export function inboundFieldValues(record: InboundConfigRecord): InboundFieldMap {
  const config = jsonObject(record.config);
  const settings = plainObject(config.settings);
  const stream = jsonObject(config.streamSettings);
  const sniffing = plainObject(config.sniffing);
  const tls = plainObject(stream.tlsSettings);
  const reality = plainObject(Object.keys(plainObject(stream.realitySettings)).length ? stream.realitySettings : tls.reality);
  const realitySettings = plainObject(reality.settings);
  const ws = plainObject(stream.wsSettings);
  const upgrade = plainObject(stream.httpupgradeSettings);
  const h2 = plainObject(stream.httpSettings);
  const grpc = plainObject(stream.grpcSettings);
  const xhttp = plainObject(stream.xhttpSettings);
  const xhttpExtra = plainObject(xhttp.extra);
  const xmux = plainObject(xhttpExtra.xmux);
  const kcp = plainObject(stream.kcpSettings);
  const kcpHeader = plainObject(kcp.header);
  const hysteria = plainObject(stream.hysteriaSettings);
  const tcp = plainObject(stream.network === "raw" ? stream.rawSettings : stream.tcpSettings);
  const header = plainObject(tcp.header);
  const wsHeaders = plainObject(ws.headers);
  const sockopt = plainObject(stream.sockopt);
  const happyEyeballs = plainObject(sockopt.happyEyeballs);
  const certificate = plainObject(Array.isArray(tls.certificates) ? tls.certificates[0] : null);
  const alpn = stringList(tls.alpn);
  const destOverride = stringList(sniffing.destOverride);
  const trafficReset = record.trafficReset ?? plainText(config.trafficReset, "never");
  return {
    name: record.name,
    protocol: record.protocol,
    network: record.network,
    port: String(record.port),
    listen: record.listen ?? plainText(config.listen),
    minimumLevel: String(record.minimumLevel ?? 0),
    multiplier: String(record.multiplier ?? 1),
    enabled: record.enabled !== false,
    planEnabled: record.planEnabled !== false,
    baseConfig: JSON.stringify(config),
    security: plainText(stream.security, "none"),
    // Inbound-level 3X-UI fields.
    totalGb: record.total ? String(record.total / 1_000_000_000) : "",
    expiryTime: localDateTime(record.expiryTime ?? 0),
    trafficReset,
    trafficResetDay: String(record.trafficResetDay ?? 0),
    tag: record.tag ?? plainText(config.tag),
    shareAddrStrategy: record.shareAddrStrategy ?? plainText(config.shareAddrStrategy, "node"),
    shareAddr: record.shareAddr ?? plainText(config.shareAddr),
    subSortIndex: String(record.subSortIndex ?? 1),
    excludeFromSub: record.excludeFromSub === true,
    disableFlow: record.disableFlow === true,
    clientFlow: record.defaultFlow ?? "",
    // Protocol settings.
    vlessDecryption: plainText(settings.decryption, "none"),
    protocolFallbacks: compactJson(settings.fallbacks),
    protocolAccounts: compactJson(settings.accounts),
    ssMethod: plainText(settings.method, "2022-blake3-aes-128-gcm"),
    ssPassword: plainText(settings.password),
    ssNetwork: plainText(settings.network, "tcp,udp"),
    dokodemoAddress: plainText(settings.address),
    dokodemoPort: String(settings.port ?? 0),
    dokodemoNetwork: plainText(settings.network, "tcp"),
    dokodemoFollowRedirect: settings.followRedirect === true,
    dokodemoTimeout: String(settings.timeout ?? 300),
    proxyAuth: plainText(settings.auth, "noauth"),
    proxyUdp: settings.udp === true,
    proxyIp: plainText(settings.ip),
    httpAllowTransparent: settings.allowTransparent === true,
    httpUserLevel: String(settings.userLevel ?? 0),
    wireguardSecretKey: plainText(settings.secretKey),
    wireguardAddress: stringList(settings.address).join(","),
    wireguardMtu: String(settings.mtu ?? 1420),
    wireguardPeers: compactJson(settings.peers),
    wireguardNoise: compactJson(settings.noise),
    wireguardNoKernelTun: settings.noKernelTun === true,
    // Transports.
    wsPath: plainText(ws.path, "/"),
    wsHost: plainText(wsHeaders.Host),
    wsHeaders: compactJson(Object.fromEntries(Object.entries(wsHeaders).filter(([key]) => key !== "Host"))),
    wsHeartbeatPeriod: String(ws.heartbeatPeriod ?? 0),
    wsMaxEarlyData: String(ws.maxEarlyData ?? 0),
    wsEarlyDataHeaderName: plainText(ws.earlyDataHeaderName),
    wsAcceptProxyProtocol: ws.acceptProxyProtocol === true,
    upgradePath: plainText(upgrade.path, "/"),
    upgradeHost: plainText(upgrade.host),
    upgradeHeaders: compactJson(upgrade.headers),
    upgradeAcceptProxyProtocol: upgrade.acceptProxyProtocol === true,
    h2Path: plainText(h2.path, "/"),
    h2Host: stringList(h2.host).join(","),
    h2Method: plainText(h2.method, "PUT"),
    h2Headers: compactJson(h2.headers),
    h2ReadIdleTimeout: String(h2.readIdleTimeout ?? 0),
    h2HealthCheckTimeout: String(h2.healthCheckTimeout ?? 0),
    grpcService: plainText(grpc.serviceName),
    grpcAuthority: plainText(grpc.authority),
    grpcMultiMode: grpc.multiMode === true,
    grpcIdleTimeout: String(grpc.idle_timeout ?? 0),
    grpcHealthCheckTimeout: String(grpc.health_check_timeout ?? 0),
    grpcPermitWithoutStream: grpc.permit_without_stream === true,
    grpcInitialWindowsSize: String(grpc.initial_windows_size ?? 0),
    xhttpPath: plainText(xhttp.path, "/"),
    xhttpHost: plainText(xhttp.host),
    xhttpMode: plainText(xhttp.mode, "auto"),
    xhttpHeaders: compactJson(xhttp.headers),
    xhttpXPaddingBytes: plainText(xhttpExtra.xPaddingBytes, ""),
    xhttpScMaxBufferedPosts: String(xhttpExtra.scMaxBufferedPosts ?? 0),
    xhttpScMaxEachPostBytes: String(xhttpExtra.scMaxEachPostBytes ?? 0),
    xhttpNoGRPCHeader: xhttpExtra.noGRPCHeader === true,
    xhttpMaxConcurrency: String(xmux.maxConcurrency ?? 0),
    xhttpMaxConnections: String(xmux.maxConnections ?? 0),
    xhttpCMaxReuseTimes: String(xmux.cMaxReuseTimes ?? 0),
    xhttpHMaxRequestTimes: String(xmux.hMaxRequestTimes ?? 0),
    xhttpHKeepAlivePeriod: String(xmux.hKeepAlivePeriod ?? 0),
    xhttpMaxLifetime: String(xmux.maxLifetime ?? 0),
    kcpMtu: String(kcp.mtu ?? 1350),
    kcpTti: String(kcp.tti ?? 20),
    kcpUplinkCapacity: String(kcp.uplinkCapacity ?? 5),
    kcpDownlinkCapacity: String(kcp.downlinkCapacity ?? 20),
    kcpCwndMultiplier: String(kcp.cwndMultiplier ?? 1),
    kcpMaxSendingWindow: String(kcp.maxSendingWindow ?? 2097152),
    kcpCongestion: kcp.congestion === true,
    kcpReadBufferSize: String(kcp.readBufferSize ?? 0),
    kcpWriteBufferSize: String(kcp.writeBufferSize ?? 0),
    kcpHeaderType: plainText(kcpHeader.type, "none"),
    kcpSeed: plainText(kcp.seed),
    tcpHeader: plainText(header.type, "none"),
    tcpAcceptProxyProtocol: tcp.acceptProxyProtocol === true,
    tcpRequest: compactJson(header.request),
    tcpResponse: compactJson(header.response),
    hysteriaVersion: String(hysteria.version ?? 2),
    hysteriaAuth: plainText(hysteria.auth),
    hysteriaUdpIdleTimeout: String(hysteria.udpIdleTimeout ?? 60),
    hysteriaMasquerade: compactJson(hysteria.masquerade),
    // Security.
    tlsSni: plainText(tls.serverName),
    tlsAlpn: alpn.join(","),
    tlsCipherSuites: stringList(tls.cipherSuites).join(","),
    tlsMinVersion: plainText(tls.minVersion),
    tlsMaxVersion: plainText(tls.maxVersion),
    tlsFingerprint: plainText(tls.fingerprint),
    tlsCurves: stringList(tls.curves).join(","),
    tlsRejectUnknownSni: tls.rejectUnknownSni === true,
    tlsDisableSystemRoot: tls.disableSystemRoot === true,
    tlsSessionResumption: plainText(tls.sessionResumption),
    tlsMasterKeyLog: plainText(tls.masterKeyLog),
    tlsEchSockopt: compactJson(tls.echSockopt),
    tlsCertFile: plainText(certificate.certificateFile),
    tlsKeyFile: plainText(certificate.keyFile),
    tlsCertPem: typeof certificate.certificate === "string" ? certificate.certificate : stringList(certificate.certificate).join("\n\n"),
    tlsKeyPem: typeof certificate.key === "string" ? certificate.key : stringList(certificate.key).join("\n\n"),
    tlsCertUsage: plainText(certificate.usage),
    tlsCertOcspStapling: certificate.ocspStapling === true,
    tlsCertOneTimeLoading: certificate.oneTimeLoading === true,
    tlsCertBuildChain: certificate.buildChain === true,
    tlsCertificates: Array.isArray(tls.certificates) && tls.certificates.length > 1 ? JSON.stringify(tls.certificates) : "",
    realityDest: plainText(reality.dest),
    realitySni: stringList(reality.serverNames).join(","),
    realityPrivateKey: plainText(reality.privateKey),
    realityPublicKey: plainText(realitySettings.publicKey),
    realityShortIds: stringList(reality.shortIds).join(","),
    realityFingerprint: plainText(realitySettings.fingerprint, "chrome"),
    realitySpiderX: plainText(realitySettings.spiderX, "/"),
    realityShow: reality.show === true,
    realityXver: String(reality.xver ?? 0),
    realityMinClientVer: plainText(reality.minClientVer),
    realityMaxClientVer: plainText(reality.maxClientVer),
    realityMaxTimediff: String(reality.maxTimediff ?? 0),
    realityMldsa65Seed: plainText(reality.mldsa65Seed),
    realityMldsa65Verify: plainText(reality.mldsa65Verify),
    // Sockopt and final masks.
    sockTcpFastOpen: sockopt.tcpFastOpen === true,
    sockTcpNoDelay: sockopt.tcpNoDelay === true,
    sockTcpMptcp: sockopt.tcpMptcp === true,
    sockTcpCongestion: plainText(sockopt.tcpcongestion),
    sockTcpKeepAliveIdle: String(sockopt.tcpKeepAliveIdle ?? 0),
    sockTcpKeepAliveInterval: String(sockopt.tcpKeepAliveInterval ?? 0),
    sockTcpUserTimeout: String(sockopt.tcpUserTimeout ?? 0),
    sockTcpWindowClamp: String(sockopt.tcpWindowClamp ?? 0),
    sockTcpMaxSeg: String(sockopt.tcpMaxSeg ?? 0),
    sockTproxy: plainText(sockopt.tproxy, "off"),
    sockDomainStrategy: plainText(sockopt.domainStrategy),
    sockDialerProxy: plainText(sockopt.dialerProxy),
    sockInterface: plainText(sockopt.interface),
    sockMark: String(sockopt.mark ?? 0),
    sockHappyEyeballsTryDelayMs: String(happyEyeballs.tryDelayMs ?? 0),
    sockHappyEyeballsPrioritizeIPv4: happyEyeballs.prioritizeIPv4 === true,
    sockHappyEyeballsInterleave: happyEyeballs.interleave === true,
    sockHappyEyeballsMaxConcurrentTry: String(happyEyeballs.maxConcurrentTry ?? 0),
    sockCustomSockopt: compactJson(sockopt.customSockopt),
    tcpMasks: compactJson(stream.tcpMasks),
    udpMasks: compactJson(stream.udpMasks),
    // Sniffing.
    sniffEnabled: sniffing.enabled !== false,
    sniffDest: (destOverride.length ? destOverride : [...inboundSniffTargets]).join(","),
    sniffMetadataOnly: sniffing.metadataOnly === true,
    sniffRouteOnly: sniffing.routeOnly === true,
    sniffDomainsExcluded: stringList(sniffing.domainsExcluded).join(","),
    sniffIpsExcluded: stringList(sniffing.ipsExcluded).join(","),
  };
}
