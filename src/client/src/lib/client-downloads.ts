export type SubscriptionFormat = "clash" | "v2ray" | "shadowsocks";
export type ClientOS = "android" | "ios" | "macos" | "linux" | "windows";
export type ClientArch = "x64" | "arm64";
type LocalizedNote = { zh: string; en: string };
export type ClientDownload = { os: ClientOS; arch: ClientArch; url: string; kind: "download" | "store"; version: string };
export type DownloadClient = {
  id: string;
  name: string;
  formats: SubscriptionFormat[];
  sourceUrl: string;
  guideUrl: string;
  notes: LocalizedNote;
  builds: ClientDownload[];
};

// 2026-11-17：官方 Releases API 核实的精确 tag 和资产名。
function release(repo: string, tag: string, version: string, assets: Array<[ClientOS, ClientArch, string]>): ClientDownload[] {
  return assets.map(([os, arch, asset]) => ({ os, arch, version, kind: "download", url: `https://github.com/${repo}/releases/download/${tag}/${asset}` }));
}
export const CLIENT_DOWNLOADS: DownloadClient[] = [
  {
    id: "clash-verge", name: "Clash Verge Rev", formats: ["clash"],
    sourceUrl: "https://github.com/clash-verge-rev/clash-verge-rev/releases/tag/v2.5.10",
    guideUrl: "https://www.clashverge.dev/guide/quickstart.html",
    notes: { zh: "稳定版 2.5.10 · Windows 10/11；macOS 12+；Linux 为 Debian/Ubuntu 的 deb 包。", en: "Stable 2.5.10 · Windows 10/11; macOS 12+; Linux packages are deb files for Debian/Ubuntu." },
    builds: release("clash-verge-rev/clash-verge-rev", "v2.5.10", "2.5.10", [
      ["windows", "x64", "Clash.Verge_2.5.10_x64-setup.exe"], ["windows", "arm64", "Clash.Verge_2.5.10_arm64-setup.exe"],
      ["macos", "x64", "Clash.Verge_2.5.10_x64.dmg"], ["macos", "arm64", "Clash.Verge_2.5.10_aarch64.dmg"],
      ["linux", "x64", "Clash.Verge_2.5.10_amd64.deb"], ["linux", "arm64", "Clash.Verge_2.5.10_arm64.deb"],
    ]),
  },
  {
    id: "cmfa", name: "Clash Meta for Android", formats: ["clash"],
    sourceUrl: "https://github.com/MetaCubeX/ClashMetaForAndroid/releases/tag/v2.11.37", guideUrl: "https://github.com/MetaCubeX/ClashMetaForAndroid",
    notes: { zh: "稳定版 2.11.37 · Android 5.0+。支持一键导入：clashmeta://install-config?url= 后追加 encodeURIComponent(Clash订阅链接)。", en: "Stable 2.11.37 · Android 5.0+. Supports one-tap import with clashmeta://install-config?url= followed by encodeURIComponent(Clash subscription URL)." },
    builds: release("MetaCubeX/ClashMetaForAndroid", "v2.11.37", "2.11.37", [["android", "x64", "cmfa-2.11.37-meta-x86_64-release.apk"], ["android", "arm64", "cmfa-2.11.37-meta-arm64-v8a-release.apk"]]),
  },
  {
    id: "v2rayn", name: "v2rayN", formats: ["v2ray"],
    sourceUrl: "https://github.com/2dust/v2rayN/releases/tag/7.25.6", guideUrl: "https://github.com/2dust/v2rayN/wiki/Release-files-introduction",
    notes: { zh: "稳定版 7.25.6 · Windows 10+；macOS 13.6+；Debian 12+ / Ubuntu 24.04+。支持 SS 协议节点；请使用本站 v2ray 订阅。", en: "Stable 7.25.6 · Windows 10+; macOS 13.6+; Debian 12+ / Ubuntu 24.04+. Supports SS protocol nodes; use this site's v2ray subscription." },
    builds: release("2dust/v2rayN", "7.25.6", "7.25.6", [
      ["windows", "x64", "v2rayN-windows-64.zip"], ["windows", "arm64", "v2rayN-windows-arm64.zip"],
      ["macos", "x64", "v2rayN-macos-64.dmg"], ["macos", "arm64", "v2rayN-macos-arm64.dmg"],
      ["linux", "x64", "v2rayN-linux-64.deb"], ["linux", "arm64", "v2rayN-linux-arm64.deb"],
    ]),
  },
  {
    id: "v2rayng", name: "v2rayNG", formats: ["v2ray"],
    sourceUrl: "https://github.com/2dust/v2rayNG/releases/tag/2.3.15", guideUrl: "https://github.com/2dust/v2rayNG",
    notes: { zh: "稳定版 2.3.15 · Android 7.0+。", en: "Stable 2.3.15 · Android 7.0+." },
    builds: release("2dust/v2rayNG", "2.3.15", "2.3.15", [["android", "x64", "v2rayNG_2.3.15_x86_64.apk"], ["android", "arm64", "v2rayNG_2.3.15_arm64-v8a.apk"]]),
  },
  {
    id: "ss-android", name: "Shadowsocks Android", formats: [],
    sourceUrl: "https://github.com/shadowsocks/shadowsocks-android/releases/tag/v5.3.5-nightly", guideUrl: "https://github.com/shadowsocks/shadowsocks-android",
    notes: { zh: "5.3.5-nightly · 非稳定版 · Android 6.0+，通用 APK。支持 SS 单节点，不保证支持本站 SIP008 订阅；需要单节点配置时请联系运营方。", en: "5.3.5-nightly · Pre-release · Android 6.0+, universal APK. Supports individual SS nodes; compatibility with this site's SIP008 subscription is unverified. Contact the operator for individual node configuration." },
    builds: release("shadowsocks/shadowsocks-android", "v5.3.5-nightly", "5.3.5-nightly", [["android", "x64", "shadowsocks-5.3.5-nightly.apk"], ["android", "arm64", "shadowsocks-5.3.5-nightly.apk"]]),
  },
  {
    id: "ss-macos", name: "ShadowsocksX-NG2", formats: [],
    sourceUrl: "https://github.com/shadowsocks/ShadowsocksX-NG/releases/tag/v2.0.0-alpha.2", guideUrl: "https://github.com/shadowsocks/ShadowsocksX-NG",
    notes: { zh: "2.0.0-alpha.2 · Alpha 测试版 · 仅 macOS 15+ / Apple Silicon。SIP008 订阅兼容性未核实。", en: "2.0.0-alpha.2 · Alpha pre-release · macOS 15+ / Apple Silicon only. SIP008 subscription compatibility is unverified." },
    builds: release("shadowsocks/ShadowsocksX-NG", "v2.0.0-alpha.2", "2.0.0-alpha.2", [["macos", "arm64", "ShadowsocksX-NG2-2.0.0-alpha.2-3-arm64.dmg"]]),
  },
  {
    id: "ss-windows", name: "Shadowsocks Windows", formats: [],
    sourceUrl: "https://github.com/shadowsocks/shadowsocks-windows/releases/tag/4.4.1.0", guideUrl: "https://github.com/shadowsocks/shadowsocks-windows",
    notes: { zh: "4.4.1.0 为 2022 年旧版，官方包未分架构，无法核实所选架构安装包。可改用支持 SS 节点的 v2rayN；SIP008 兼容性未核实。", en: "4.4.1.0 is a legacy 2022 release without architecture-specific packages. A build for the selected architecture is unverified. Consider v2rayN for SS nodes; SIP008 compatibility is unverified." },
    builds: [],
  },
  {
    id: "stash", name: "Stash", formats: ["clash"], sourceUrl: "https://apps.apple.com/us/app/stash-rule-based-proxy/id1596063349", guideUrl: "https://stash.wiki/get-started",
    notes: { zh: "核验版本 5.0.0 · iOS 16+ · 商店应用，可能付费或有地区限制。", en: "Verified version 5.0.0 · iOS 16+ · Store app; payment or regional restrictions may apply." },
    builds: [{ os: "ios", arch: "arm64", kind: "store", version: "5.0.0", url: "https://apps.apple.com/us/app/stash-rule-based-proxy/id1596063349" }],
  },
  {
    id: "shadowrocket", name: "Shadowrocket", formats: ["v2ray"], sourceUrl: "https://apps.apple.com/us/app/shadowrocket/id932747118", guideUrl: "https://shadowlaunch.com/",
    notes: { zh: "核验版本 2.2.93 · iOS 13+ · 可能付费或有地区限制。支持 SS 与常见 v2ray 节点格式；本站 v2ray 订阅兼容性待客户端实测，SIP008 兼容性未核实。文档链接为开发者主页。", en: "Verified version 2.2.93 · iOS 13+ · Payment or regional restrictions may apply. Supports SS and common v2ray node formats; compatibility with this site's v2ray subscription requires client testing, and SIP008 support is unverified. Documentation links to the developer's homepage." },
    builds: [{ os: "ios", arch: "arm64", kind: "store", version: "2.2.93", url: "https://apps.apple.com/us/app/shadowrocket/id932747118" }],
  },
];
