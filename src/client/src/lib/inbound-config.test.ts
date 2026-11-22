import { describe, expect, it } from "vitest";
import { buildInboundConfig, buildInboundMeta, inboundFieldValues, maskRows, maskRowsJson } from "./inbound-config";

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
      settings: { clients: [], decryption: "none", encryption: "none" },
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
    expect(rebuilt.settings).toEqual({ clients: [{ id: "client-uuid", email: "manual@test" }], fallbacks: [{ dest: 80 }], decryption: "none", encryption: "none" });
    expect((rebuilt.streamSettings as Record<string, unknown>).externalProxy).toEqual([{ forceTls: "tls" }]);
    expect((rebuilt.streamSettings as Record<string, unknown>).wsSettings).toEqual({ acceptProxyProtocol: false, path: "/new", headers: {} });
  });

  it("replaces stored clients with the list edited in the form", () => {
    const existing = { settings: { clients: [{ id: "old", email: "old@test" }], decryption: "none" } };
    const fields = inboundFieldValues({ name: "Tokyo", protocol: "vless", network: "tcp", port: 443, minimumLevel: 0, multiplier: 1, enabled: true, config: existing });
    expect(fields.clients).toBe('[{"id":"old","email":"old@test"}]');
    const next = [{ id: "new", email: "new@test", enable: true, totalGB: 0, expiryTime: 0, flow: "", limitIp: 0, subId: "abc123", reset: 0 }];
    const rebuilt = buildInboundConfig({ ...fields, clients: JSON.stringify(next) });
    expect(rebuilt.settings).toEqual({ clients: next, decryption: "none", encryption: "none" });
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
      finalmask: { tcp: [{ type: "fragment", settings: {} }] },
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

  it("round-trips VLESS ML-KEM encryption and keeps it when other fields change", () => {
    const existing = {
      settings: { decryption: "mlkem768x25519plus.native.600s.server-key", encryption: "mlkem768x25519plus.native.0rtt.client-key" },
      streamSettings: { network: "ws", security: "none", wsSettings: { path: "/" } },
    };
    const fields = inboundFieldValues({ name: "ML-KEM", protocol: "vless", network: "ws", port: 443, minimumLevel: 0, multiplier: 1, enabled: true, config: existing });
    expect(fields).toMatchObject({ vlessDecryption: "mlkem768x25519plus.native.600s.server-key", vlessEncryption: "mlkem768x25519plus.native.0rtt.client-key" });
    const rebuilt = buildInboundConfig({ ...fields, wsPath: "/new" });
    expect(rebuilt.settings).toMatchObject({ decryption: "mlkem768x25519plus.native.600s.server-key", encryption: "mlkem768x25519plus.native.0rtt.client-key" });
    const cleared = buildInboundConfig({ ...fields, vlessDecryption: "none", vlessEncryption: "none" });
    expect(cleared.settings).toMatchObject({ decryption: "none", encryption: "none" });
  });

  it("writes finalmask and still reads the legacy mask keys", () => {
    const legacy = inboundFieldValues({ name: "old", protocol: "vless", network: "tcp", port: 443, minimumLevel: 0, multiplier: 1, enabled: true, config: { streamSettings: { network: "tcp", tcpMasks: [{ type: "fragment" }], udpMasks: [{ type: "mkcp-legacy" }] } } });
    expect(legacy).toMatchObject({ tcpMasks: '[{"type":"fragment"}]', udpMasks: '[{"type":"mkcp-legacy"}]' });
    const rebuilt = buildInboundConfig({ ...baseFields, network: "tcp", security: "none", tcpMasks: '[{"type":"fragment"}]', udpMasks: '[{"type":"mkcp-legacy"}]' });
    expect((rebuilt.streamSettings as Record<string, unknown>).finalmask).toEqual({ tcp: [{ type: "fragment" }], udp: [{ type: "mkcp-legacy" }] });
    expect((rebuilt.streamSettings as Record<string, unknown>).tcpMasks).toBeUndefined();
  });

  it("merges the advanced JSON slices last", () => {
    const config = buildInboundConfig({ ...baseFields, streamExtra: '{"sockopt":{"tcpFastOpen":true}}', sniffExtra: '{"ipsExcluded":["10.0.0.0/8"]}' });
    expect((config.streamSettings as Record<string, unknown>).sockopt).toEqual({ tcpFastOpen: true });
    expect(config.sniffing).toMatchObject({ ipsExcluded: ["10.0.0.0/8"] });
    const broken = buildInboundConfig({ ...baseFields, streamExtra: "{ not json", sniffExtra: "{ not json" });
    expect((broken.streamSettings as Record<string, unknown>).sockopt).toBeUndefined();
    expect(broken.sniffing).toMatchObject({ enabled: true });
  });

  it("derives the 3X-UI tag from the port and transports", () => {
    expect(buildInboundMeta({ ...baseFields, tag: "", port: "8443", network: "tcp" }).tag).toBe("in-8443-tcp");
    expect(buildInboundMeta({ ...baseFields, tag: "", port: "9000", network: "kcp" }).tag).toBe("in-9000-udp");
    expect(buildInboundMeta({ ...baseFields, protocol: "shadowsocks", tag: "", port: "8388", ssNetwork: "tcp,udp" }).tag).toBe("in-8388-tcpudp");
    expect(buildInboundMeta({ ...baseFields, protocol: "wireguard", tag: "", port: "51820" }).tag).toBe("in-51820-udp");
    expect(buildInboundMeta({ ...baseFields, tag: "custom-tag" }).tag).toBe("custom-tag");
  });

  it("builds and reads the XDRIVE transport", () => {
    const config = buildInboundConfig({
      ...baseFields,
      network: "xdrive",
      security: "none",
      xdriveService: "s3",
      xdriveRemoteFolder: "xray-tunnel",
      xdriveSecrets: "AKIA, secret, token",
      xdriveSegmentBytes: "262144",
      xdriveConcurrency: "8",
      xdriveS3Endpoint: "https://s3.example.test",
      xdriveS3Region: "us-east-1",
      xdriveS3Bucket: "bucket",
      xdriveS3PathStyle: false,
      xdriveFront: "www.googleapis.com",
      xdriveFrontPort: "443",
    });
    const stream = config.streamSettings as Record<string, unknown>;
    expect(stream).toMatchObject({
      network: "xdrive",
      address: "www.googleapis.com",
      port: 443,
      xdriveSettings: {
        service: "s3",
        remoteFolder: "xray-tunnel",
        secrets: ["AKIA", "secret", "token"],
        segmentBytes: 262144,
        concurrency: 8,
        s3: { endpoint: "https://s3.example.test", region: "us-east-1", bucket: "bucket", pathStyle: false },
      },
    });
    expect(stream.tcpSettings).toBeUndefined();

    const fields = inboundFieldValues({ name: "Drive", protocol: "vless", network: "xdrive", port: 443, minimumLevel: 0, multiplier: 1, enabled: true, config });
    expect(fields).toMatchObject({
      xdriveService: "s3", xdriveSecrets: "AKIA,secret,token", xdriveS3PathStyle: false,
      xdriveFront: "www.googleapis.com", xdriveFrontPort: "443", xdriveSegmentBytes: "262144",
    });
    const rebuilt = buildInboundConfig(fields);
    expect((rebuilt.streamSettings as Record<string, unknown>).xdriveSettings).toEqual(stream.xdriveSettings);
  });

  it("round-trips finalmask quicParams and keeps unknown keys", () => {
    const existing = {
      streamSettings: {
        network: "hysteria",
        finalmask: {
          udp: [{ type: "salamander", settings: { password: "psk" } }],
          quicParams: { congestion: "bbr", bbrProfile: "aggressive", udpHop: { ports: "30000-40000", interval: "3-5" }, maxIdleTimeout: 30, customKey: true },
        },
      },
    };
    const fields = inboundFieldValues({ name: "QUIC", protocol: "vless", network: "hysteria", port: 443, minimumLevel: 0, multiplier: 1, enabled: true, config: existing });
    expect(fields).toMatchObject({
      quicCongestion: "bbr", quicBbrProfile: "aggressive", quicUdpHopPorts: "30000-40000",
      quicUdpHopInterval: "3-5", quicMaxIdleTimeout: "30", quicExtra: '{"customKey":true}',
    });
    const rebuilt = buildInboundConfig({ ...fields, quicCongestion: "reno" });
    expect((rebuilt.streamSettings as Record<string, unknown>).finalmask).toEqual({
      udp: [{ type: "salamander", settings: { password: "psk" } }],
      quicParams: { congestion: "reno", bbrProfile: "aggressive", udpHop: { ports: "30000-40000", interval: "3-5" }, maxIdleTimeout: 30, customKey: true },
    });
  });

  it("parses and serializes mask rows without losing hand-written JSON", () => {
    expect(maskRows('[{"type":"fragment","settings":{"lengths":["1"]}}]')).toEqual({
      rows: [{ type: "fragment", settings: '{"lengths":["1"]}' }],
      broken: false,
    });
    expect(maskRows("{ not json").broken).toBe(true);
    expect(maskRowsJson([{ type: "fragment", settings: '{"packets":"1-1"}' }])).toEqual({
      value: '[{"type":"fragment","settings":{"packets":"1-1"}}]',
      invalid: false,
    });
    expect(maskRowsJson([{ type: "fragment", settings: "{ not json" }]).invalid).toBe(true);
    expect(maskRowsJson([{ type: "", settings: "" }])).toEqual({ value: "", invalid: false });
  });
});
