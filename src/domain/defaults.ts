import type { Inbound, InboundNodeBinding, NodeRecord, Plan, User } from "./types";
import type { DocumentStore } from "../storage/store";

export const FREE_PLAN_ID = "plan-free";
export const SESSION_COOKIE = "3xui_session";
export const SESSION_DAYS = 7;

export function validSortIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 9999;
}

export function isMainlandNode(node: Pick<NodeRecord, "name" | "region">): boolean {
  const label = `${node.region ?? ""} ${node.name}`;
  if (/香港|澳门|澳門|台湾|臺灣|台灣|hong\s*kong|macau|macao|taiwan/i.test(label)) return false;
  return /大陆|大陸|江苏|江蘇|镇江|鎮江|陕西|陝西|西安|北京|上海|天津|重庆|重慶|广东|廣東|广州|廣州|深圳|浙江|杭州|福建|福州|厦门|廈門|山东|山東|湖北|湖南|四川|成都|河南|河北|山西|安徽|江西|广西|廣西|海南|辽宁|遼寧|吉林|黑龙江|黑龍江|贵州|貴州|云南|雲南|甘肃|甘肅|青海|宁夏|寧夏|内蒙古|內蒙古|新疆|西藏|mainland|jiangsu|zhenjiang|xi.?an|shaanxi/i.test(label) || /^(cn|china|中国|中國)$/i.test(node.region?.trim() ?? "");
}

export function compareNodes(a: Pick<NodeRecord, "id" | "name" | "region" | "sortIndex">, b: Pick<NodeRecord, "id" | "name" | "region" | "sortIndex">): number {
  return Number(isMainlandNode(b)) - Number(isMainlandNode(a))
    || (a.sortIndex ?? 0) - (b.sortIndex ?? 0)
    || a.name.localeCompare(b.name, "zh-CN", { numeric: true }) || a.id.localeCompare(b.id);
}

/** An inbound is mainland-only when all its known bound nodes are mainland nodes. */
export function mainlandInboundIds(bindings: readonly InboundNodeBinding[], nodes: readonly NodeRecord[]): Set<string> {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const locations = new Map<string, boolean[]>();
  for (const binding of bindings) {
    const node = nodesById.get(binding.nodeId);
    if (!node) continue;
    const flags = locations.get(binding.inboundId) ?? [];
    flags.push(isMainlandNode(node));
    locations.set(binding.inboundId, flags);
  }
  return new Set([...locations].filter(([, flags]) => flags.every(Boolean)).map(([id]) => id));
}

export function compareInbounds(a: Inbound, b: Inbound, mainlandIds: ReadonlySet<string>): number {
  return Number(mainlandIds.has(b.id)) - Number(mainlandIds.has(a.id))
    || (a.subSortIndex ?? 1) - (b.subSortIndex ?? 1)
    || a.name.localeCompare(b.name, "zh-CN", { numeric: true }) || a.id.localeCompare(b.id);
}

/**
 * An inbound serves a plan user when it is enabled, plan-enabled and either the user's current
 * plan is explicitly bound or, for legacy inbounds without bindings, the level gate is met.
 */
export function servesPlan(inbound: Inbound, user: Pick<User, "planId" | "planLevel">): boolean {
  if (!inbound.enabled || inbound.planEnabled === false) return false;
  const boundPlans = (inbound.planIds ?? []).filter((id) => Boolean(id));
  if (boundPlans.length) return Boolean(user.planId) && boundPlans.includes(user.planId);
  return inbound.minimumLevel <= user.planLevel;
}

export const defaultPlan: Plan = {
  id: FREE_PLAN_ID,
  name: "Free",
  description: "Default account without a paid subscription",
  group: "default",
  level: 0,
  trafficBytes: 0,
  validityDays: 0,
  resetUnit: "month",
  resetInterval: 1,
  resetAtHour: 0,
  resetWeekday: 1,
  resetMonthDay: 1,
  priceMinor: 0,
  currency: "USD",
  allowPaidUpgrade: false,
  isDefault: true,
  enabled: true,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

/** The browser title and the sidebar brand text, overridable from system settings. */
export const DEFAULT_SITE_TITLE = "3XUI Manager";
export const MAX_SITE_TITLE_LENGTH = 60;

export const defaultSettings: Record<string, unknown> = {
  siteTitle: DEFAULT_SITE_TITLE,
  registrationEnabled: true,
  emailVerificationRequired: true,
  turnstileEnabled: false,
  turnstileOnCheckin: false,
  inviteRequired: false,
  userInvitesEnabled: false,
  userInviteLimit: 0,
  defaultBalanceMinor: 0,
  referralPercent: 10,
  referralValidityDays: 30,
  checkinTrafficBytes: 200 * 1024 * 1024,
  deleteInactiveAfterDays: 0,
  deleteWithoutPlanAfterDays: 0,
  warnBeforeDeleteDays: 3,
  notifyTrafficExhausted: false,
  notifySubscriptionExpired: false,
  notifyTrafficReset: false,
  notifyOrderExpired: false,
  notifyReferralReward: false,
  notifyAccountCleanup: false,
  timezone: "UTC",
  trafficSampleCursor: 0,
};

export async function ensureDefaultPlan(store: DocumentStore): Promise<void> {
  if (!(await store.has("plans", FREE_PLAN_ID))) await store.put("plans", FREE_PLAN_ID, defaultPlan);
}

export async function ensureDefaults(store: DocumentStore): Promise<void> {
  await ensureDefaultPlan(store);
  for (const [key, value] of Object.entries(defaultSettings)) {
    if (!(await store.has("settings", key))) await store.put("settings", key, { key, value, updatedAt: new Date().toISOString() });
  }
}

export async function readSetting<T>(store: DocumentStore, key: string, fallback: T): Promise<T> {
  const row = await store.get<{ key: string; value: T }>("settings", key);
  return row?.value ?? fallback;
}

export interface CheckinRewardRange {
  minRewardBytes: number;
  maxRewardBytes: number;
}

export async function readCheckinRewardRange(store: DocumentStore, overrides: Record<string, unknown> = {}): Promise<CheckinRewardRange | null> {
  const keys = ["checkinTrafficBytes", "checkinMinTrafficBytes", "checkinMaxTrafficBytes"];
  const values = await Promise.all(keys.map(async (key) => {
    if (Object.hasOwn(overrides, key)) return overrides[key];
    return (await store.get<{ value: unknown }>("settings", key))?.value;
  }));
  const legacy = values[0] === undefined ? defaultSettings.checkinTrafficBytes : values[0];
  const min = values[1] === undefined ? legacy : values[1];
  const max = values[2] === undefined ? legacy : values[2];
  if (typeof min !== "number" || typeof max !== "number" || !Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 0 || min > max) return null;
  return { minRewardBytes: min, maxRewardBytes: max };
}

/** Rejection sampling over 53 random bits avoids modulo bias, including the safe-integer limit. */
export function randomCheckinReward({ minRewardBytes: min, maxRewardBytes: max }: CheckinRewardRange): number {
  if (min === max) return min;
  const width = BigInt(max) - BigInt(min) + 1n;
  const space = 1n << 53n;
  const limit = space - space % width;
  const words = new Uint32Array(2);
  let sample: bigint;
  do {
    crypto.getRandomValues(words);
    sample = (BigInt(words[0]! & 0x1fffff) << 32n) | BigInt(words[1]!);
  } while (sample >= limit);
  return min + Number(sample % width);
}

export async function writeSetting<T>(store: DocumentStore, key: string, value: T): Promise<void> {
  await store.put("settings", key, { key, value, updatedAt: new Date().toISOString() });
}
