import type { RuntimeEnv } from "../env";
import type { DocumentStore, Page } from "../storage/store";
import { sendEmail } from "./email";

export type NotificationType = "order-expired" | "traffic-exhausted" | "subscription-expired" | "traffic-reset" | "referral-reward" | "account-cleanup";
export type NotificationEmailStatus = "disabled" | "pending" | "sent" | "failed";

export interface UserNotification {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  emailEnabled: boolean;
  emailStatus: NotificationEmailStatus;
  emailAttempts: number;
  emailNextAttemptAt: string | null;
}

export interface CreateNotificationInput {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  emailEnabled?: boolean;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

export function notificationRecordId(userId: string, id: string): string {
  return `${userId}:${id}`;
}

async function tryDeliver(store: DocumentStore, env: RuntimeEnv, recordId: string): Promise<void> {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) return;
  const lockName = `notification-send:${recordId}`;
  const owner = crypto.randomUUID();
  if (!(await store.acquireLease(lockName, owner, Date.now() + 60_000))) return;
  try {
    const notification = await store.get<UserNotification>("notifications", recordId);
    if (!notification || !notification.emailEnabled || (notification.emailStatus !== "pending" && notification.emailStatus !== "failed") || notification.emailAttempts >= 5) return;
    if (notification.emailNextAttemptAt && Date.parse(notification.emailNextAttemptAt) > Date.now()) return;
    notification.emailAttempts += 1;
    notification.emailNextAttemptAt = new Date(Date.now() + Math.min(60, 2 ** notification.emailAttempts) * 60_000).toISOString();
    notification.emailStatus = "pending";
    await store.put("notifications", recordId, notification);
    try {
      const recipient = await store.get<{ email: string }>("users", notification.userId);
      if (!recipient?.email) {
        notification.emailStatus = "failed";
        notification.emailAttempts = 5;
        notification.emailNextAttemptAt = null;
        await store.put("notifications", recordId, notification);
        return;
      }
      await sendEmail(env, recipient.email, notification.title, `<p>${escapeHtml(notification.body)}</p>`);
      notification.emailStatus = "sent";
      notification.emailNextAttemptAt = null;
    } catch (error) {
      notification.emailStatus = notification.emailAttempts >= 5 ? "failed" : "pending";
      console.error(JSON.stringify({ event: "notification_email_failed", notificationId: notification.id, attempts: notification.emailAttempts, message: error instanceof Error ? error.message : "unknown" }));
    }
    await store.put("notifications", recordId, notification);
  } finally {
    await store.releaseLease(lockName, owner);
  }
}

export async function createUserNotification(store: DocumentStore, env: RuntimeEnv, input: CreateNotificationInput): Promise<UserNotification | null> {
  const recordId = notificationRecordId(input.userId, input.id);
  const lockName = `notification-event:${recordId}`;
  const owner = crypto.randomUUID();
  if (!(await store.acquireLease(lockName, owner, Date.now() + 30_000))) return store.get<UserNotification>("notifications", recordId);
  let notification: UserNotification | null = null;
  try {
    notification = await store.get<UserNotification>("notifications", recordId);
    if (!notification) {
      const now = new Date().toISOString();
      notification = {
        ...input,
        emailEnabled: input.emailEnabled ?? false,
        emailStatus: input.emailEnabled ? "pending" : "disabled",
        emailAttempts: 0,
        emailNextAttemptAt: null,
        createdAt: now,
        readAt: null,
      };
      await store.put("notifications", recordId, notification);
    }
  } finally {
    await store.releaseLease(lockName, owner);
  }
  if (notification.emailEnabled && notification.emailStatus !== "sent") await tryDeliver(store, env, recordId);
  return (await store.get<UserNotification>("notifications", recordId)) ?? notification;
}

async function listAll<T>(store: DocumentStore, collection: string): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<T> = await store.list<T>(collection, { limit: 100, cursor });
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  return items;
}

export async function deliverPendingNotifications(store: DocumentStore, env: RuntimeEnv): Promise<number> {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) return 0;
  const now = Date.now();
  const pending = (await listAll<UserNotification>(store, "notifications"))
    .filter((notification) => notification.emailEnabled && (notification.emailStatus === "pending" || notification.emailStatus === "failed") && notification.emailAttempts < 5 && (!notification.emailNextAttemptAt || Date.parse(notification.emailNextAttemptAt) <= now));
  for (const notification of pending) await tryDeliver(store, env, notificationRecordId(notification.userId, notification.id));
  return pending.length;
}
