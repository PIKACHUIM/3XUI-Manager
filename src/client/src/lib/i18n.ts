import { EXTRA_MESSAGES } from "./i18n-messages";
import { INLINE_PHRASES } from "./i18n-phrases";
import { TRANSLATED_LOCALES, expandRows } from "./i18n-support";

export const LOCALES = ["zh", "zh-TW", "en", "ja", "ko", "de", "es", "pt", "it", "ar", "ru", "fr"] as const;

export type Locale = (typeof LOCALES)[number];

export const LOCALE_META: Record<Locale, { native: string; english: string; dir: "ltr" | "rtl" }> = {
  zh: { native: "简体中文", english: "Chinese (Simplified)", dir: "ltr" },
  "zh-TW": { native: "繁體中文", english: "Chinese (Traditional)", dir: "ltr" },
  en: { native: "English", english: "English", dir: "ltr" },
  ja: { native: "日本語", english: "Japanese", dir: "ltr" },
  ko: { native: "한국어", english: "Korean", dir: "ltr" },
  de: { native: "Deutsch", english: "German", dir: "ltr" },
  es: { native: "Español", english: "Spanish", dir: "ltr" },
  pt: { native: "Português", english: "Portuguese", dir: "ltr" },
  it: { native: "Italiano", english: "Italian", dir: "ltr" },
  ar: { native: "العربية", english: "Arabic", dir: "rtl" },
  ru: { native: "Русский", english: "Russian", dir: "ltr" },
  fr: { native: "Français", english: "French", dir: "ltr" },
};

const base = {
  zh: {
    brand: "3XUI Manager", subtitle: "节点管理平台", overview: "使用概览", subscription: "订阅信息", nodes: "节点列表", plans: "套餐中心", account: "账号管理", checkin: "每日签到", users: "用户管理", inbounds: "入站管理", orders: "订单管理", system: "系统设置", billing: "计费与订单", network: "网络服务", workspace: "工作台", management: "管理中心", search: "搜索", notifications: "通知", profile: "我的账户", settings: "偏好设置", theme: "主题颜色", language: "语言", light: "浅色", dark: "深色", hello: "早上好", userName: "Alex Chen", dashboardTitle: "你的网络，一目了然。", dashboardSub: "连接状态良好，今天也在平稳运行。", remaining: "剩余流量", balance: "账户余额", planUntil: "订阅有效期", activeNodes: "可用节点", usageTitle: "流量使用情况", last30: "近 30 天", thisMonth: "本周期", trafficByNode: "节点用量排行", liveNodes: "在线节点", allNodes: "查看全部", node: "节点", location: "地区", multiplier: "倍率", latency: "延迟", status: "状态", online: "在线", offline: "离线", connected: "连接中", recent: "最近动态", seeAll: "查看全部", dashboard: "控制台", userPortal: "用户中心", adminPortal: "管理后台", switchAdmin: "切换管理后台", switchUser: "切换用户中心", upgrade: "升级套餐", copyLink: "复制订阅链接", copied: "已复制", add: "新增", edit: "编辑", delete: "删除", searchPlaceholder: "搜索名称、邮箱或节点…", noData: "暂无记录", mockNotice: "演示数据 · 连接存储后显示实时信息", userCount: "用户总数", activeSubs: "有效订阅", monthRevenue: "本月收入", nodeHealth: "节点在线率", planName: "极光 · 进阶版", planStatus: "当前套餐", daysLeft: "剩余 18 天", navUser: "用户门户", navAdmin: "系统管理", changeTheme: "切换主题", monthTraffic: "本周期用量", viewPlans: "浏览套餐", manage: "管理", email: "邮箱", role: "角色", created: "注册时间", plan: "套餐", usage: "用量", price: "价格", period: "周期", actions: "操作", active: "正常", expired: "已过期", paid: "已支付", pending: "待支付", failed: "失败", group: "套餐分组", overviewStat: "过去 30 天共使用 128.6 GB", checkinDone: "今日签到成功", settingsTitle: "平台设置", syncStatus: "同步状态", realtimeSync: "实时同步", trafficSync: "每分钟流量同步", searchNodes: "搜索节点", welcome: "欢迎回来", points: "连续签到 6 天", viewReport: "查看报告", allTime: "累计用量", todayUsage: "今日用量", resetIn: "下次重置还有", days: "天", activity: "流量活动", overviewMenu: "总览", statusGood: "运行稳定", manageTitle: "在这里管理你的", manageSuffix: "网络服务", addNode: "添加节点", addInbound: "创建入站", createPlan: "创建套餐", invite: "邀请好友", signupTrend: "注册趋势", orderTrend: "订单趋势", save: "保存更改", cancel: "取消", refresh: "刷新数据", customer: "客户", admin: "管理员", enabled: "已启用", disabled: "已停用", expiry: "到期时间", level: "等级", trafficLimit: "流量额度", priceLabel: "套餐价格", resetCycle: "重置周期", multiplierLabel: "流量倍率", nodeCount: "绑定节点", clientCount: "客户端", payment: "支付方式", orderNo: "订单号", date: "创建时间", amount: "金额", source: "来源", clearSearch: "清除搜索", noResults: "没有匹配的数据", apiStatus: "API 服务正常", storageMode: "存储模式", d1Mode: "D1 数据库", kvMode: "KV 存储", refreshSoon: "实时同步状态会在接入节点后显示", upcoming: "即将推出", syncing: "同步中", failedSync: "同步失败", display: "显示偏好", quickActions: "快捷操作", planDescription: "适合日常使用的高速连接套餐", includedTraffic: "本周期已用流量", available: "余量充足", renew: "续订套餐", support: "需要帮助？联系支持团队", accountEmail: "账户邮箱", subscriptionLink: "订阅链接", copy: "复制", activeUsers: "活跃用户", nodeLoad: "节点负载", onlineNow: "实时在线", today: "今日", vsLastMonth: "较上月", traffic: "流量", dateShort: "日期", usageByNode: "按节点统计", usageByDay: "每日用量", healthy: "健康", operations: "操作", filtering: "筛选", details: "详情", signIn: "邮箱登录", register: "创建账号", password: "密码", forgotPassword: "忘记密码？", inviteCode: "邀请码", turnstile: "人机验证", signInDesc: "登录你的安全网络空间", referrals: "邀请返利", attendance: "签到奖励", emails: "通知邮件", security: "安全设置", saveSuccess: "更改已保存", retry: "重试", all: "全部", monthly: "每月", weekly: "每周", daily: "每日", more: "更多", systemStatus: "系统状态", syncingNow: "正在同步到节点"
  },
  en: {
    brand: "3XUI Manager", subtitle: "Node management", overview: "Overview", subscription: "Subscription", nodes: "Nodes", plans: "Plans", account: "Account", checkin: "Daily check-in", users: "Users", inbounds: "Inbounds", orders: "Orders", system: "System settings", billing: "Billing & orders", network: "Network", workspace: "Workspace", management: "Management", search: "Search", notifications: "Notifications", profile: "My account", settings: "Preferences", theme: "Accent color", changeTheme: "Change theme", language: "Language", light: "Light", dark: "Dark", hello: "Good morning", userName: "Alex Chen", dashboardTitle: "Your network, at a glance.", dashboardSub: "Everything is connected and running smoothly today.", remaining: "Traffic remaining", balance: "Account balance", planUntil: "Subscription ends", activeNodes: "Available nodes", usageTitle: "Traffic usage", last30: "Last 30 days", thisMonth: "This cycle", trafficByNode: "Traffic by node", liveNodes: "Live nodes", allNodes: "View all", node: "Node", location: "Location", multiplier: "Multiplier", latency: "Latency", status: "Status", online: "Online", offline: "Offline", connected: "Connected", recent: "Recent activity", seeAll: "See all", dashboard: "Dashboard", userPortal: "User portal", adminPortal: "Admin console", switchAdmin: "Switch to admin", switchUser: "Switch to user portal", upgrade: "Upgrade plan", copyLink: "Copy subscription link", copied: "Copied", add: "Add new", edit: "Edit", delete: "Delete", searchPlaceholder: "Search name, email, or node…", noData: "No records yet", mockNotice: "Sample data · Connect storage to view live information", userCount: "Total users", activeSubs: "Active subscriptions", monthRevenue: "Revenue this month", nodeHealth: "Node availability", planName: "Aurora · Plus", planStatus: "Current plan", daysLeft: "18 days left", monthTraffic: "Cycle usage", viewPlans: "Explore plans", manage: "Manage", email: "Email", role: "Role", created: "Joined", plan: "Plan", usage: "Usage", price: "Price", period: "Period", actions: "Actions", active: "Active", expired: "Expired", paid: "Paid", pending: "Pending", failed: "Failed", group: "Plan group", overviewStat: "128.6 GB used over the last 30 days", checkinDone: "Checked in today", settingsTitle: "Platform settings", syncStatus: "Sync status", realtimeSync: "Real-time sync", trafficSync: "Traffic sync · every minute", searchNodes: "Search nodes", welcome: "Welcome back", points: "6-day streak", viewReport: "View report", allTime: "Lifetime usage", todayUsage: "Used today", resetIn: "Resets in", days: "days", activity: "Traffic activity", overviewMenu: "Overview", statusGood: "All systems healthy", manageTitle: "Manage your", manageSuffix: "network service", addNode: "Add node", addInbound: "Create inbound", createPlan: "Create plan", invite: "Invite friends", signupTrend: "Sign-up trend", orderTrend: "Order trend", save: "Save changes", cancel: "Cancel", refresh: "Refresh data", customer: "Customer", admin: "Admin", enabled: "Enabled", disabled: "Disabled", expiry: "Expires", level: "Level", trafficLimit: "Traffic limit", priceLabel: "Plan price", resetCycle: "Reset cycle", multiplierLabel: "Traffic multiplier", nodeCount: "Nodes bound", clientCount: "Clients", payment: "Payment method", orderNo: "Order ID", date: "Created at", amount: "Amount", source: "Source", clearSearch: "Clear search", noResults: "No matching records", apiStatus: "API healthy", storageMode: "Storage mode", d1Mode: "D1 Database", kvMode: "KV Storage", refreshSoon: "Live sync appears when nodes are connected", upcoming: "Coming soon", syncing: "Syncing", failedSync: "Sync failed", display: "Display preferences", quickActions: "Quick actions", planDescription: "A fast, reliable connection for everyday use", includedTraffic: "Traffic used this cycle", available: "Plenty remaining", renew: "Renew plan", support: "Need a hand? Contact our support team", accountEmail: "Account email", subscriptionLink: "Subscription link", copy: "Copy", activeUsers: "Active users", nodeLoad: "Node load", onlineNow: "Online now", today: "Today", vsLastMonth: "vs last month", traffic: "Traffic", dateShort: "Date", usageByNode: "By node", usageByDay: "Daily usage", healthy: "Healthy", operations: "Operations", filtering: "Filter", details: "Details", signIn: "Sign in with email", register: "Create account", password: "Password", forgotPassword: "Forgot password?", inviteCode: "Invite code", turnstile: "Human verification", signInDesc: "Sign in to your secure network space", referrals: "Referral rewards", attendance: "Check-in rewards", emails: "Email notifications", security: "Security", saveSuccess: "Changes saved", retry: "Retry", all: "All", monthly: "Monthly", weekly: "Weekly", daily: "Daily", more: "More", systemStatus: "System status", syncingNow: "Syncing with nodes"
  }
} as const;

export type MessageKey = keyof typeof base.en;

export const EN_MESSAGES = base.en;

type Catalog = Partial<Record<MessageKey, string>>;

const expanded = expandRows<MessageKey>(EXTRA_MESSAGES);

export const messages: Record<Locale, Catalog> = {
  zh: base.zh,
  en: base.en,
  ...expanded,
};

const EN_BY_TEXT = new Map<string, MessageKey>();
for (const [key, text] of Object.entries(base.en)) EN_BY_TEXT.set(text, key as MessageKey);

const TRANSLATED_INDEX = TRANSLATED_LOCALES as readonly string[];

function rowIndex(locale: Locale): number {
  return TRANSLATED_INDEX.indexOf(locale);
}

/** Localizes a short inline pair; locales outside zh/en fall back through the shared catalog. */
export function say(locale: Locale, zh: string, en: string): string {
  if (locale === "en") return en;
  if (locale === "zh") return zh;
  const key = EN_BY_TEXT.get(en);
  const translated = key ? messages[locale][key] : undefined;
  if (translated) return translated;
  const index = rowIndex(locale);
  const row = INLINE_PHRASES[en];
  if (row && index >= 0) return row[index] || en;
  return locale === "zh-TW" ? zh : en;
}

/** Localizes a sentence template and fills its {placeholder} slots. */
export function phrase(locale: Locale, zh: string, en: string, vars: Record<string, string | number>): string {
  return say(locale, zh, en).replace(/\{(\w+)\}/g, (_match, name: string) => String(vars[name] ?? ""));
}

/** Picks a locale-specific value, useful for messages that interpolate runtime data. */
export function pick<T>(locale: Locale, values: Partial<Record<Locale, T>> & { en: T }): T {
  return values[locale] ?? values.en;
}

export function isLocale(value: string | null | undefined): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

function matchLocale(tag: string): Locale | null {
  const lower = tag.toLowerCase();
  if (lower.startsWith("zh")) return /(hant|tw|hk|mo)/.test(lower) ? "zh-TW" : "zh";
  const primary = lower.split("-")[0];
  return isLocale(primary) ? primary : null;
}

export const LOCALE_STORAGE_KEY = "3xui-locale";

export function detectLocale(): Locale {
  try {
    const saved = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch { /* Language preference is optional. */ }
  if (typeof navigator === "undefined") return "en";
  const tags = [...(navigator.languages ?? []), navigator.language];
  for (const tag of tags) {
    const match = matchLocale(tag);
    if (match) return match;
  }
  return "en";
}

export function saveLocale(locale: Locale): void {
  try { window.localStorage.setItem(LOCALE_STORAGE_KEY, locale); } catch { /* Language preference is optional. */ }
}

export function localeDirection(locale: Locale): "ltr" | "rtl" {
  return LOCALE_META[locale].dir;
}

