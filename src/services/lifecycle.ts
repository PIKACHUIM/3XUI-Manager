import { FREE_PLAN_ID, ensureDefaults, readSetting } from "../domain/defaults";
import type { Order, User } from "../domain/types";
import type { RuntimeEnv } from "../env";
import { getStore } from "../storage";
import type { DocumentStore, Page } from "../storage/store";
import { expirePendingOrders } from "./billing";
import { createUserNotification, deliverPendingNotifications, notificationRecordId, type UserNotification } from "./notifications";

interface RetentionMarker {
  userId: string;
  reason: string;
  scheduledFor: string;
  notificationId: string;
}

async function listAll<T>(store: DocumentStore, collection: string, prefix?: string): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<T> = await store.list<T>(collection, { limit: 100, cursor, prefix });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return items;
}

function validDays(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3650 ? value : 0;
}

async function accountCleanupReason(store: DocumentStore, user: User, now: number, inactiveDays: number, withoutPlanDays: number, orders: Order[], users: User[]): Promise<string | null> {
  const activePaidPlan = user.planId !== FREE_PLAN_ID && (!user.planExpiresAt || Date.parse(user.planExpiresAt) > now);
  if (user.role !== "user" || !user.enabled || activePaidPlan || user.balanceMinor !== 0 || user.inviteCount > 0 || users.some((candidate) => candidate.invitedBy === user.id)) return null;
  if (orders.some((order) => order.userId === user.id && order.status === "pending")) return null;
  if ((await store.list("clients", { limit: 1, prefix: `${user.id}:` })).items.length > 0) return null;
  const activityAt = Date.parse(user.lastActiveAt ?? user.createdAt);
  const createdAt = Date.parse(user.createdAt);
  const inactive = inactiveDays > 0 && Number.isFinite(activityAt) && activityAt <= now - inactiveDays * 86400000;
  const hasNoPlan = user.planId === FREE_PLAN_ID || (user.planExpiresAt !== null && Date.parse(user.planExpiresAt) <= now);
  const withoutPlan = withoutPlanDays > 0 && hasNoPlan && Number.isFinite(createdAt) && createdAt <= now - withoutPlanDays * 86400000;
  if (!inactive && !withoutPlan) return null;
  return [inactive ? "inactive" : "", withoutPlan ? "without-plan" : ""].filter(Boolean).join("+");
}

async function processRetention(store: DocumentStore, env: RuntimeEnv, now: Date, users: User[], orders: Order[]): Promise<number> {
  const [inactiveSetting, withoutPlanSetting, warningSetting, emailEnabled] = await Promise.all([
    readSetting<unknown>(store, "deleteInactiveAfterDays", 0),
    readSetting<unknown>(store, "deleteWithoutPlanAfterDays", 0),
    readSetting<unknown>(store, "warnBeforeDeleteDays", 3),
    readSetting<boolean>(store, "notifyAccountCleanup", false),
  ]);
  const inactiveDays = validDays(inactiveSetting);
  const withoutPlanDays = validDays(withoutPlanSetting);
  const warningDays = validDays(warningSetting);
  if (inactiveDays === 0 && withoutPlanDays === 0) {
    const markers = await listAll<RetentionMarker>(store, "account-retention");
    for (const marker of markers) {
      await store.delete("account-retention", marker.userId);
      await store.delete("notifications", notificationRecordId(marker.userId, marker.notificationId));
    }
    return 0;
  }
  let deleted = 0;
  for (const user of users) {
    const marker = await store.get<RetentionMarker>("account-retention", user.id);
    const reason = await accountCleanupReason(store, user, now.getTime(), inactiveDays, withoutPlanDays, orders, users);
    if (!reason) {
      if (marker) {
        await store.delete("account-retention", user.id);
        await store.delete("notifications", notificationRecordId(user.id, marker.notificationId));
      }
      continue;
    }
    let currentMarker = marker;
    if (!currentMarker || currentMarker.reason !== reason) {
      if (currentMarker) await store.delete("notifications", notificationRecordId(user.id, currentMarker.notificationId));
      const scheduledFor = new Date(now.getTime() + warningDays * 86400000).toISOString();
      currentMarker = { userId: user.id, reason, scheduledFor, notificationId: `account-cleanup:${user.id}:${scheduledFor}` };
      await store.put("account-retention", user.id, currentMarker);
      await createUserNotification(store, env, {
        id: currentMarker.notificationId, userId: user.id, type: "account-cleanup",
        title: "Account cleanup scheduled", body: `Your account is scheduled for cleanup on ${scheduledFor} because it is ${reason}. Sign in or update your plan before then to keep it.`,
        emailEnabled,
      });
    }
    if (Date.parse(currentMarker.scheduledFor) > now.getTime()) continue;
    const lockName = `payment-user:${user.id}`;
    const owner = crypto.randomUUID();
    if (!(await store.acquireLease(lockName, owner, now.getTime() + 60_000))) continue;
    try {
      const latest = await store.get<User>("users", user.id);
      const latestUsers = await listAll<User>(store, "users");
      const latestOrders = await listAll<Order>(store, "orders");
      if (!latest || await accountCleanupReason(store, latest, Date.now(), inactiveDays, withoutPlanDays, latestOrders, latestUsers) !== currentMarker.reason) {
        await store.delete("account-retention", user.id);
        await store.delete("notifications", notificationRecordId(user.id, currentMarker.notificationId));
        continue;
      }
      const sessions = await listAll<{ id: string; userId: string }>(store, "sessions");
      for (const session of sessions) if (session.userId === user.id) await store.delete("sessions", session.id);
      await store.delete("user-email", latest.email);
      const notifications = await listAll<UserNotification>(store, "notifications", `${user.id}:`);
      for (const notification of notifications) await store.delete("notifications", notificationRecordId(user.id, notification.id));
      await store.delete("users", user.id);
      await store.delete("account-retention", user.id);
      deleted += 1;
    } finally {
      await store.releaseLease(lockName, owner);
    }
  }
  return deleted;
}

export async function runLifecycleMaintenance(env: RuntimeEnv): Promise<void> {
  const store = getStore(env);
  const owner = crypto.randomUUID();
  if (!(await store.acquireLease("lifecycle-maintenance", owner, Date.now() + 55_000))) return;
  try {
    await ensureDefaults(store);
    const now = new Date();
    const expiredOrders = await expirePendingOrders(store, env, now);
    const users = await listAll<User>(store, "users");
    const orders = await listAll<Order>(store, "orders");
    const [notifyExhausted, notifyExpired] = await Promise.all([
      readSetting<boolean>(store, "notifyTrafficExhausted", false),
      readSetting<boolean>(store, "notifySubscriptionExpired", false),
    ]);
    for (const user of users) {
      if (user.role !== "user") continue;
      if (user.planTrafficBytes > 0 && user.billedBytes >= user.planTrafficBytes) {
        await createUserNotification(store, env, {
          id: `traffic-exhausted:${user.id}:${user.planStartedAt}`, userId: user.id, type: "traffic-exhausted",
          title: "Traffic quota exhausted", body: "Your current plan has used all available traffic.", emailEnabled: notifyExhausted,
        });
      }
      if (user.planId !== FREE_PLAN_ID && user.planExpiresAt && Number.isFinite(Date.parse(user.planExpiresAt)) && Date.parse(user.planExpiresAt) <= now.getTime()) {
        await createUserNotification(store, env, {
          id: `subscription-expired:${user.id}:${user.planExpiresAt}`, userId: user.id, type: "subscription-expired",
          title: "Subscription expired", body: "Your subscription has expired. Choose a plan to restore service.", emailEnabled: notifyExpired,
        });
      }
    }
    const deletedAccounts = await processRetention(store, env, now, users, orders);
    const retriedEmails = await deliverPendingNotifications(store, env);
    console.info(JSON.stringify({ event: "lifecycle_maintenance_complete", expiredOrders, deletedAccounts, retriedEmails }));
  } finally {
    await store.releaseLease("lifecycle-maintenance", owner);
  }
}
