import { describe, expect, it } from "vitest";
import { buildInboundConfig, buildInboundMeta, inboundFieldValues } from "./inbound-config";

const baseFields = {
  protocol: "vless",
  network: "ws",
  security: "none",
  wsPath: "/ray",
  wsHost: "cdn.example.test",
  sniffEnabled: true,
  sniffDest: "http,tls",
  baseConfig: "{}",
};

describe("inbound config builder", () => {
  it("turns form fields into a 3X-UI vless/ws payload", () => {
    const config = buildInboundConfig(baseFields);
    expect(config).toEqual({
      settings: { clients: [], decryption: "none" },
      streamSettings: {
        network: "ws",
        security: "none",
        wsSettings: { acceptProxyProtocol: false, path: "/ray", headers: { Host: "cdn.example.test" } },
      },
      sniffing: { enabled: true, destOverride: ["http", "tls"], metadataOnly: false, routeOnly: false },
    });
  });

  it("builds REALITY and TLS transports from their own fields", () => {
    const reality = buildInboundConfig({
      ...baseFields,
      network: "tcp",
      tcpHeader: "none",
      security: "reality",
      realityDest: "www.microsoft.com:443",
      realitySni: "www.microsoft.com, www.bing.com",
      realityPrivateKey: "private-key",
      realityPublicKey: "public-key",
      realityShortIds: "ab, cd",
      realityFingerprint: "firefox",
    });
    expect(reality.streamSettings).toEqual({
      network: "tcp",
      security: "reality",
      tcpSettings: { acceptProxyProtocol: false, header: { type: "none" } },
      realitySettings: {
        show: false,
        xver: 0,
        dest: "www.microsoft.com:443",
        serverNames: ["www.microsoft.com", "www.bing.com"],
        privateKey: "private-key",
        shortIds: ["ab", "cd"],
        settings: { publicKey: "public-key", fingerprint: "firefox", serverName: "www.microsoft.com", spiderX: "/" },
      },
    });

    const tls = buildInboundConfig({
      ...baseFields,
      network: "grpc",
      grpcService: "grpc-svc",
      security: "tls",
      tlsSni: "node.example.test",
      tlsAlpn: "h2, http/1.1",
      tlsCertFile: "/etc/ssl/fullchain.pem",
      tlsKeyFile: "/etc/ssl/privkey.pem",
    });
    expect(tls.streamSettings).toEqual({
      network: "grpc",
      security: "tls",
      grpcSettings: { serviceName: "grpc-svc", authority: "", multiMode: false },
      tlsSettings: { serverName: "node.example.test", alpn: ["h2", "http/1.1"], certificates: [{ certificateFile: "/etc/ssl/fullchain.pem", keyFile: "/etc/ssl/privkey.pem" }] },
    });
  });

  it("keeps panel-managed clients and unknown stream keys when an inbound is edited", () => {
    const existing = {
      settings: { clients: [{ id: "client-uuid", email: "manual@test" }], decryption: "none", fallbacks: [{ dest: 80 }] },
      streamSettings: { network: "ws", security: "tls", externalProxy: [{ forceTls: "tls" }], tlsSettings: { serverName: "old.example.test" } },
      sniffing: { enabled: false, destOverride: ["tls"] },
    };
    const fields = inboundFieldValues({ name: "Tokyo", protocol: "vless", network: "ws", port: 443, minimumLevel: 0, multiplier: 1, enabled: true, config: existing });
    expect(fields).toMatchObject({ security: "tls", wsPath: "/", wsHost: "", sniffEnabled: false, sniffDest: "tls", planEnabled: true });
    const rebuilt = buildInboundConfig({ ...fields, wsPath: "/new" });
    expect(rebuilt.settings).toEqual({ clients: [{ id: "client-uuid", email: "manual@test" }], fallbacks: [{ dest: 80 }], decryption: "none" });
    expect((rebuilt.streamSettings as Record<string, unknown>).externalProxy).toEqual([{ forceTls: "tls" }]);
    expect((rebuilt.streamSettings as Record<string, unknown>).wsSettings).toEqual({ acceptProxyProtocol: false, path: "/new", headers: {} });
  });

  it("replaces stored clients with the list edited in the form", () => {
    const existing = { settings: { clients: [{ id: "old", email: "old@test" }], decryption: "none" } };
    const fields = inboundFieldValues({ name: "Tokyo", protocol: "vless", network: "tcp", port: 443, minimumLevel: 0, multiplier: 1, enabled: true, config: existing });
    expect(fields.clients).toBe('[{"id":"old","email":"old@test"}]');
    const next = [{ id: "new", email: "new@test", enable: true, totalGB: 0, expiryTime: 0, flow: "", limitIp: 0, subId: "abc123", reset: 0 }];
    const rebuilt = buildInboundConfig({ ...fields, clients: JSON.stringify(next) });
    expect(rebuilt.settings).toEqual({ clients: next, decryption: "none" });
  });

  it("handles shadowsocks credentials and disabled sniffing", () => {
    const config = buildInboundConfig({
      ...baseFields,
      protocol: "shadowsocks",
      network: "tcp",
      security: "none",
      ssMethod: "aes-256-gcm",
      ssPassword: "ss-secret",
      sniffEnabled: false,
      sniffDest: "",
    });
    expect(config.settings).toEqual({ clients: [], method: "aes-256-gcm", password: "ss-secret", network: "tcp,udp" });
    expect(config.sniffing).toEqual({ enabled: false, destOverride: [], metadataOnly: false, routeOnly: false });
  });

  it("maps the inbound-level 3X-UI fields and reads them back", () => {
    const meta = buildInboundMeta({
      ...baseFields,
      totalGb: "1.5",
      expiryTime: "2027-01-02T03:04",
      trafficReset: "monthly",
      trafficResetDay: "7",
      tag: "tokyo-ws",
      shareAddrStrategy: "custom",
      shareAddr: "edge.example.test",
      subSortIndex: "4",
      excludeFromSub: true,
      disableFlow: true,
      clientFlow: "xtls-rprx-vision",
    });
    expect(meta).toEqual({
      listen: "", total: 1_500_000_000, expiryTime: Date.parse("2027-01-02T03:04"), trafficReset: "monthly",
      trafficResetDay: 7, tag: "tokyo-ws", shareAddrStrategy: "custom", shareAddr: "edge.example.test",
      subSortIndex: 4, excludeFromSub: true, disableFlow: true, defaultFlow: "xtls-rprx-vision",
    });
    expect(buildInboundMeta({ ...baseFields, trafficReset: "yearly", totalGb: "-3" })).toMatchObject({ trafficReset: "never", total: 0, subSortIndex: 1 });
    const values = inboundFieldValues({
      name: "Tokyo", protocol: "vless", network: "ws", port: 443, minimumLevel: 0, multiplier: 1, enabled: true, planEnabled: true, config: {}, ...meta,
    });
    expect(values).toMatchObject({
      totalGb: "1.5", trafficReset: "monthly", trafficResetDay: "7", tag: "tokyo-ws", shareAddrStrategy: "custom",
      shareAddr: "edge.example.test", subSortIndex: "4", excludeFromSub: true, disableFlow: true, clientFlow: "xtls-rprx-vision",
    });
    expect(values.expiryTime).toBe("2027-01-02T03:04");
  });

  it("builds advanced transport, TLS, sockopt and sniffing details", () => {
    const config = buildInboundConfig({
      ...baseFields,
      network: "xhttp",
      security: "tls",
      xhttpMode: "stream-one",
      xhttpXPaddingBytes: "100-1000",
      xhttpNoGRPCHeader: true,
      xhttpMaxConcurrency: "16",
      tlsSni: "node.example.test",
      tlsCipherSuites: "TLS_AES_128_GCM_SHA256, TLS_AES_256_GCM_SHA384",
      tlsMinVersion: "1.2",
      tlsRejectUnknownSni: true,
      tlsCertPem: "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----",
      tlsKeyPem: "-----BEGIN PRIVATE KEY-----\nBBB\n-----END PRIVATE KEY-----",
      sockTcpFastOpen: true,
      sockTcpCongestion: "bbr",
      sockHappyEyeballsTryDelayMs: "250",
      sockHappyEyeballsPrioritizeIPv4: true,
      sniffRouteOnly: true,
      sniffDomainsExcluded: "example.org, example.net",
      tcpMasks: '[{"type":"fragment","settings":{}}]',
    });
    expect(config.streamSettings).toMatchObject({
      network: "xhttp",
      xhttpSettings: { path: "/", host: "", mode: "stream-one", extra: { xPaddingBytes: "100-1000", noGRPCHeader: true, xmux: { maxConcurrency: 16 } } },
      sockopt: { tcpFastOpen: true, tcpcongestion: "bbr", happyEyeballs: { tryDelayMs: 250, prioritizeIPv4: true } },
      tcpMasks: [{ type: "fragment", settings: {} }],
      tlsSettings: {
        serverName: "node.example.test",
        cipherSuites: ["TLS_AES_128_GCM_SHA256", "TLS_AES_256_GCM_SHA384"],
        minVersion: "1.2",
        rejectUnknownSni: true,
        certificates: [{
          useFile: false,
          certificate: ["-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----"],
          key: ["-----BEGIN PRIVATE KEY-----\nBBB\n-----END PRIVATE KEY-----"],
        }],
      },
    });
    expect(config.sniffing).toEqual({
      enabled: true, destOverride: ["http", "tls"], metadataOnly: false, routeOnly: true,
      domainsExcluded: ["example.org", "example.net"],
    });
  });

  it("builds mKCP, HTTP/2, gRPC and TCP header details", () => {
    const kcp = buildInboundConfig({ ...baseFields, network: "kcp", kcpMtu: "1400", kcpHeaderType: "srtp", kcpCongestion: true, kcpSeed: "seed-1" });
    expect((kcp.streamSettings as Record<string, unknown>).kcpSettings).toEqual({
      mtu: 1400, tti: 20, uplinkCapacity: 5, downlinkCapacity: 20, cwndMultiplier: 1, maxSendingWindow: 2097152,
      header: { type: "srtp" }, congestion: true, seed: "seed-1",
    });

    const h2 = buildInboundConfig({ ...baseFields, network: "http", h2Host: "a.example.test, b.example.test", h2Method: "GET" });
    expect((h2.streamSettings as Record<string, unknown>).httpSettings).toEqual({
      host: ["a.example.test", "b.example.test"], path: "/", method: "GET", headers: {},
    });

    const grpc = buildInboundConfig({ ...baseFields, network: "grpc", grpcMultiMode: true, grpcIdleTimeout: "60" });
    expect((grpc.streamSettings as Record<string, unknown>).grpcSettings).toEqual({
      serviceName: "", authority: "", multiMode: true, idle_timeout: 60,
    });

    const tcp = buildInboundConfig({ ...baseFields, network: "tcp", tcpHeader: "http", tcpAcceptProxyProtocol: true });
    expect((tcp.streamSettings as Record<string, unknown>).tcpSettings).toEqual({
      acceptProxyProtocol: true, header: { type: "http" },
    });
  });

  it("keeps protocol-specific settings and ignores malformed JSON", () => {
    const config = buildInboundConfig({
      ...baseFields,
      protocol: "trojan",
      protocolFallbacks: '{ not json',
      settingsExtra: '{"udp":true}',
      sniffIpsExcluded: "10.0.0.0/8",
    });
    expect(config.settings).toEqual({ clients: [], udp: true });
    expect(config.sniffing).toMatchObject({ ipsExcluded: ["10.0.0.0/8"] });

    const socks = buildInboundConfig({
      ...baseFields,
      protocol: "socks",
      proxyAuth: "password",
      protocolAccounts: '[{"user":"alice","pass":"secret"}]',
      proxyUdp: true,
      proxyIp: "127.0.0.1",
    });
    expect(socks.settings).toEqual({ auth: "password", accounts: [{ user: "alice", pass: "secret" }], udp: true, ip: "127.0.0.1" });
  });
});
