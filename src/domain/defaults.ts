import type { Inbound, Plan } from "./types";
import type { DocumentStore } from "../storage/store";

export const FREE_PLAN_ID = "plan-free";
export const SESSION_COOKIE = "3xui_session";
export const SESSION_DAYS = 7;

/** An inbound serves plan users only when it is enabled, plan-enabled and its level gate is met. */
export function servesPlan(inbound: Inbound, planLevel: number): boolean {
  return inbound.enabled && inbound.planEnabled !== false && inbound.minimumLevel <= planLevel;
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

export async function writeSetting<T>(store: DocumentStore, key: string, value: T): Promise<void> {
  await store.put("settings", key, { key, value, updatedAt: new Date().toISOString() });
}
