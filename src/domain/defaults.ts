import type { Inbound, Plan, User } from "./types";
import type { DocumentStore } from "../storage/store";

export const FREE_PLAN_ID = "plan-free";
export const SESSION_COOKIE = "3xui_session";
export const SESSION_DAYS = 7;

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

export const defaultSettings: Record<string, unknown> = {
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
