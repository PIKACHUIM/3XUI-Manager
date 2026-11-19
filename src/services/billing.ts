import type { RuntimeEnv } from "../env";
import type { Order, Plan, User } from "../domain/types";
import { readSetting } from "../domain/defaults";
import { D1Store } from "../storage/d1";
import type { DocumentStore, Page } from "../storage/store";
import { createUserNotification } from "./notifications";
import { syncUserEntitlements } from "./xui-sync";
import { createWaffoCheckout } from "../adapters/payments/waffo";

export interface CreateCheckoutInput {
  type: "topup" | "subscription" | "upgrade";
  provider: "waffo";
  planId?: string;
  amountMinor?: number;
  currency?: string;
}

const zeroDecimalCurrencies = new Set(["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
const threeDecimalCurrencies = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

export function currencyExponent(currency: string): number {
  const normalized = currency.toUpperCase();
  return zeroDecimalCurrencies.has(normalized) ? 0 : threeDecimalCurrencies.has(normalized) ? 3 : 2;
}

export function minorToMoney(amountMinor: number, currency: string): string {
  const exponent = currencyExponent(currency);
  const divisor = 10 ** exponent;
  return exponent === 0 ? String(amountMinor) : (amountMinor / divisor).toFixed(exponent);
}

export function moneyToMinor(value: string, currency: string): number | null {
  if (!/^\d+(?:\.\d+)?$/.test(value)) return null;
  const exponent = currencyExponent(currency);
  const [wholeText, fractionText = ""] = value.split(".");
  if (fractionText.length > exponent) return null;
  const whole = Number(wholeText);
  const fraction = Number((fractionText + "0".repeat(exponent)).slice(0, exponent) || "0");
  const result = whole * 10 ** exponent + fraction;
  return Number.isSafeInteger(result) ? result : null;
}

function planSnapshot(plan: Plan): Record<string, unknown> {
  return {
    id: plan.id,
    name: plan.name,
    level: plan.level,
    trafficBytes: plan.trafficBytes,
    validityDays: plan.validityDays,
    resetUnit: plan.resetUnit,
    resetInterval: plan.resetInterval,
    resetAtHour: plan.resetAtHour,
    resetWeekday: plan.resetWeekday,
    resetMonthDay: plan.resetMonthDay,
    currency: plan.currency,
  };
}

export function upgradeCredit(current: Plan | null, user: User, next: Plan, now: number): number {
  if (!current || current.priceMinor <= 0) return 0;
  const expiry = user.planExpiresAt ? Date.parse(user.planExpiresAt) : Number.NaN;
  const validityRatio = current.validityDays > 0
    ? Number.isFinite(expiry) ? Math.min(1, Math.max(0, (expiry - now) / (current.validityDays * 86400000))) : 0
    : 1;
  const trafficRatio = current.trafficBytes > 0
    ? Math.min(1, Math.max(0, (current.trafficBytes - user.billedBytes) / current.trafficBytes))
    : 0;
  const credit = current.priceMinor * Math.min(validityRatio, trafficRatio);
  return Math.min(next.priceMinor, Math.max(0, Math.round(credit)));
}

function setPlan(user: User, snapshot: Record<string, unknown>, now: string): void {
  if (typeof snapshot.id !== "string" || typeof snapshot.level !== "number" || typeof snapshot.trafficBytes !== "number" || typeof snapshot.validityDays !== "number") throw new Error("Order plan snapshot is invalid.");
  user.planId = snapshot.id;
  user.planLevel = snapshot.level;
  user.planTrafficBytes = snapshot.trafficBytes;
  user.planStartedAt = now;
  user.planExpiresAt = snapshot.validityDays > 0 ? new Date(Date.parse(now) + snapshot.validityDays * 86400000).toISOString() : null;
  user.billedBytes = 0;
  user.trafficResetAt = null;
}

export async function createCheckout(store: DocumentStore, env: RuntimeEnv, user: User, input: CreateCheckoutInput): Promise<{ order: Order | null; checkoutUrl: string | null; appliedWithoutPayment?: boolean; balanceAppliedMinor?: number }> {
  if (input.provider !== "waffo") throw new Error("Only Waffo checkout is supported.");
  const lockName = `payment-user:${user.id}`;
  const lockOwner = crypto.randomUUID();
  if (!(await store.acquireLease(lockName, lockOwner, Date.now() + 60_000))) throw new Error("Another account update is being processed.");
  let prepared: { order: Order; user: User; description: string; amount: string } | null = null;
  let appliedWithoutPayment = false;
  let balanceAppliedMinor = 0;
  let pendingOrderId: string | null = null;
  try {
    const currentUser = await store.get<User>("users", user.id);
    if (!currentUser || !currentUser.enabled) throw new Error("Account is unavailable.");
    user = currentUser;
    let plan: Plan | null = null;
    let amountMinor: number;
    let currency: string;
    let metadata: Record<string, unknown> = {};
    if (input.type === "topup") {
      amountMinor = input.amountMinor ?? 0;
      currency = (input.currency ?? "USD").toUpperCase();
      if (!Number.isSafeInteger(amountMinor) || amountMinor < 100 || amountMinor > 1_000_000) throw new Error("Top-up amount must be between 100 and 1,000,000 minor units.");
      if (!/^[A-Z]{3}$/.test(currency)) throw new Error("Currency must be a three-letter ISO code.");
    } else {
      if (!input.planId) throw new Error("Select a plan.");
      plan = await store.get<Plan>("plans", input.planId);
      if (!plan || !plan.enabled || plan.hidden || plan.isDefault || plan.priceMinor <= 0) throw new Error("Selected plan is unavailable for purchase.");
      currency = plan.currency.toUpperCase();
      amountMinor = plan.priceMinor;
      if (input.type === "subscription" && plan.level < user.planLevel && (!user.planExpiresAt || Date.parse(user.planExpiresAt) > Date.now())) throw new Error("Downgrades are not allowed while the current plan is active.");
      if (input.type === "upgrade") {
        const current = await store.get<Plan>("plans", user.planId);
        if (!plan.allowPaidUpgrade || plan.level <= user.planLevel) throw new Error("The selected plan is not an eligible paid upgrade.");
        const creditMinor = upgradeCredit(current, user, plan, Date.now());
        amountMinor = Math.max(0, plan.priceMinor - creditMinor);
        metadata = { creditMinor, planSnapshot: planSnapshot(plan) };
        if (amountMinor > 0 && store instanceof D1Store && Number.isSafeInteger(user.balanceMinor) && user.balanceMinor > 0) {
          const requested = Math.min(user.balanceMinor, amountMinor);
          const orderId = crypto.randomUUID().replaceAll("-", "");
          const debited = await store.debitUserBalanceOnce({
            userId: user.id,
            orderId: requested < amountMinor ? orderId : `settlement-${orderId}`,
            amountMinor: requested,
            currency,
            createdAt: new Date().toISOString(),
          });
          if (debited) {
            balanceAppliedMinor = requested;
            amountMinor -= requested;
            user.balanceMinor -= requested;
            metadata = { ...metadata, balanceAppliedMinor };
            if (amountMinor > 0) pendingOrderId = orderId;
          }
        }
        if (amountMinor === 0) {
          const updatedAt = new Date().toISOString();
          setPlan(user, planSnapshot(plan), updatedAt);
          user.updatedAt = updatedAt;
          if (store instanceof D1Store) {
            const updated = await store.patchUser(user.id, {
              planId: user.planId, planLevel: user.planLevel, planTrafficBytes: user.planTrafficBytes,
              planStartedAt: user.planStartedAt, planExpiresAt: user.planExpiresAt, billedBytes: 0,
              trafficResetAt: null, updatedAt,
            });
            if (!updated) throw new Error("Account is unavailable.");
          } else {
            await store.put("users", user.id, user);
          }
          appliedWithoutPayment = true;
        }
      } else {
        metadata = { planSnapshot: planSnapshot(plan) };
      }
    }
    if (!appliedWithoutPayment) {
      if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error("The payable amount must be greater than zero.");
      const createdAt = new Date().toISOString();
      const order: Order = {
        id: pendingOrderId ?? crypto.randomUUID().replaceAll("-", ""),
        userId: user.id,
        planId: plan?.id ?? null,
        type: input.type,
        amountMinor,
        currency,
        provider: input.provider,
        providerOrderId: null,
        checkoutUrl: null,
        status: "pending",
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        paidAt: null,
        metadata: { ...metadata, ...((input.type === "subscription" || input.type === "upgrade") && plan ? { planSnapshot: planSnapshot(plan) } : {}) },
        createdAt,
        updatedAt: createdAt,
      };
      await store.put("orders", order.id, order);
      const description = input.type === "topup" ? `Account balance top-up (${minorToMoney(amountMinor, currency)} ${currency})` : `${input.type === "upgrade" ? "Upgrade to" : "Subscription:"} ${plan?.name ?? "Plan"}`;
      prepared = { order, user, description, amount: minorToMoney(amountMinor, currency) };
    }
  } finally {
    await store.releaseLease(lockName, lockOwner);
  }
  if (appliedWithoutPayment) {
    await syncUserEntitlements(store, env, user.id);
    return { order: null, checkoutUrl: null, appliedWithoutPayment: true, balanceAppliedMinor };
  }
  if (!prepared) throw new Error("Checkout could not be prepared.");
  const { order, description, amount } = prepared;
  try {
    const checkout = await createWaffoCheckout(env, order, prepared.user, description, amount);
    order.checkoutUrl = checkout.checkoutUrl;
    order.providerOrderId = checkout.providerOrderId;
    order.updatedAt = new Date().toISOString();
    await store.put("orders", order.id, order);
    return { order, checkoutUrl: checkout.checkoutUrl, balanceAppliedMinor };
  } catch (error) {
    order.metadata = { ...order.metadata, checkoutError: error instanceof Error ? error.message.slice(0, 300) : "Provider request failed." };
    order.updatedAt = new Date().toISOString();
    await refundOrderBalance(store, order);
    await store.put("orders", order.id, order);
    throw error;
  }
}

/** Releases the balance reserved for an order that will not be paid. Idempotent through the ledger key. */
async function refundOrderBalance(store: DocumentStore, order: Order): Promise<void> {
  const applied = order.metadata?.balanceAppliedMinor;
  if (!(store instanceof D1Store) || typeof applied !== "number" || !Number.isSafeInteger(applied) || applied <= 0) return;
  if (order.metadata?.balanceRefundedAt) return;
  const createdAt = new Date().toISOString();
  const refunded = await store.refundUserBalanceOnce({ userId: order.userId, orderId: order.id, amountMinor: applied, currency: order.currency, createdAt });
  if (refunded) order.metadata = { ...order.metadata, balanceRefundedAt: createdAt };
}

export async function settleFailedOrder(store: DocumentStore, order: Order, eventId: string): Promise<void> {
  const lockName = `payment-user:${order.userId}`;
  const lockOwner = crypto.randomUUID();
  if (!(await store.acquireLease(lockName, lockOwner, Date.now() + 60_000))) throw new Error("Another payment for this account is being processed.");
  try {
    const currentOrder = await store.get<Order>("orders", order.id);
    if (!currentOrder) throw new Error("Order not found.");
    if (currentOrder.status !== "pending") return;
    currentOrder.status = "failed";
    currentOrder.updatedAt = new Date().toISOString();
    currentOrder.metadata = { ...currentOrder.metadata, failedEventId: eventId };
    await refundOrderBalance(store, currentOrder);
    await store.put("orders", currentOrder.id, currentOrder);
  } finally {
    await store.releaseLease(lockName, lockOwner);
  }
}

export async function settlePaidOrder(store: DocumentStore, env: RuntimeEnv, order: Order, eventId: string, providerConfirmedStatus?: "PAY_SUCCESS"): Promise<{ order: Order; sync: Awaited<ReturnType<typeof syncUserEntitlements>> }> {
  const lockName = `payment-user:${order.userId}`;
  const lockOwner = crypto.randomUUID();
  if (!(await store.acquireLease(lockName, lockOwner, Date.now() + 60_000))) throw new Error("Another payment for this account is being processed.");
  let settledOrder: Order;
  let userId: string;
  let referralReward: { userId: string; amountMinor: number; currency: string } | null = null;
  try {
    const currentOrder = await store.get<Order>("orders", order.id);
    if (!currentOrder) throw new Error("Order not found.");
    const user = await store.get<User>("users", currentOrder.userId);
    if (!user) throw new Error("Order owner not found.");
    if (currentOrder.status !== "paid") {
      if (currentOrder.status !== "pending" && !(providerConfirmedStatus === "PAY_SUCCESS" && (currentOrder.status === "failed" || currentOrder.status === "expired"))) throw new Error("Order is not payable.");
      const applied = user.appliedPaymentIds ?? [];
      if (!applied.includes(currentOrder.id)) {
        const updatedAt = new Date().toISOString();
        const reservedMinor = currentOrder.metadata?.balanceAppliedMinor;
        if (currentOrder.type === "upgrade" && store instanceof D1Store && typeof currentOrder.metadata?.balanceRefundedAt === "string"
          && typeof reservedMinor === "number" && Number.isSafeInteger(reservedMinor) && reservedMinor > 0) {
          const recharged = await store.debitUserBalanceOnce({
            userId: user.id, orderId: currentOrder.id, amountMinor: reservedMinor,
            currency: currentOrder.currency, createdAt: updatedAt, kind: "balance_recharge",
          });
          if (!recharged) throw new Error("The balance reserved for this order is no longer available.");
          currentOrder.metadata = { ...currentOrder.metadata, balanceRevivedAt: updatedAt };
        }
        const patch: Partial<User> = { appliedPaymentIds: [...applied.slice(-255), currentOrder.id], updatedAt };
        if (currentOrder.type === "topup") {
          user.balanceMinor += currentOrder.amountMinor;
          patch.balanceMinor = user.balanceMinor;
        } else {
          const snapshot = currentOrder.metadata?.planSnapshot;
          if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("Order has no valid plan snapshot.");
          setPlan(user, snapshot as Record<string, unknown>, updatedAt);
          Object.assign(patch, {
            planId: user.planId, planLevel: user.planLevel, planTrafficBytes: user.planTrafficBytes,
            planStartedAt: user.planStartedAt, planExpiresAt: user.planExpiresAt, billedBytes: 0, trafficResetAt: null,
          });
        }
        user.appliedPaymentIds = patch.appliedPaymentIds;
        user.updatedAt = updatedAt;
        if (store instanceof D1Store) {
          const updated = await store.patchUser(user.id, patch);
          if (!updated) throw new Error("Order owner not found.");
        } else {
          await store.put("users", user.id, user);
        }
      }
      const ledgerId = `payment:${currentOrder.id}`;
      if (!(await store.has("ledger-entries", ledgerId))) {
        await store.put("ledger-entries", ledgerId, {
          id: ledgerId,
          userId: user.id,
          orderId: currentOrder.id,
          kind: currentOrder.type === "topup" ? "topup" : "external_payment",
          amountMinor: currentOrder.type === "topup" ? currentOrder.amountMinor : -currentOrder.amountMinor,
          currency: currentOrder.currency,
          idempotencyKey: ledgerId,
          providerEventId: eventId,
          createdAt: new Date().toISOString(),
        });
      }
      if (store instanceof D1Store && user.invitedBy && user.invitedBy !== user.id) {
        const [percent, validityDays] = await Promise.all([
          readSetting<unknown>(store, "referralPercent", 10),
          readSetting<unknown>(store, "referralValidityDays", 30),
        ]);
        const ageMs = Date.now() - Date.parse(user.createdAt);
        if (typeof percent === "number" && Number.isFinite(percent) && percent > 0 && percent <= 100 && Number.isInteger(percent * 100)
          && typeof validityDays === "number" && Number.isInteger(validityDays) && validityDays > 0 && validityDays <= 3650
          && Number.isSafeInteger(currentOrder.amountMinor) && currentOrder.amountMinor > 0
          && Number.isFinite(ageMs) && ageMs >= 0 && ageMs < validityDays * 86400000) {
          const inviterLockName = `payment-user:${user.invitedBy}`;
          const inviterLockOwner = crypto.randomUUID();
          if (!(await store.acquireLease(inviterLockName, inviterLockOwner, Date.now() + 60_000))) throw new Error("Referral account update is busy.");
          try {
            const inviter = await store.get<User>("users", user.invitedBy);
            const inviterPlan = inviter ? await store.get<Plan>("plans", inviter.planId) : null;
            const rewardMinor = Number(BigInt(currentOrder.amountMinor) * BigInt(Math.round(percent * 100)) / 10_000n);
            if (inviter?.enabled && inviterPlan?.currency.toUpperCase() === currentOrder.currency.toUpperCase()
              && Number.isSafeInteger(inviter.balanceMinor) && inviter.balanceMinor >= 0
              && rewardMinor > 0 && Number.isSafeInteger(inviter.balanceMinor + rewardMinor)) {
              const rewarded = await store.creditUserBalanceOnce({
                userId: inviter.id, orderId: currentOrder.id, amountMinor: rewardMinor,
                currency: currentOrder.currency, createdAt: new Date().toISOString(),
              });
              if (rewarded) referralReward = { userId: inviter.id, amountMinor: rewardMinor, currency: currentOrder.currency };
            }
          } finally {
            await store.releaseLease(inviterLockName, inviterLockOwner);
          }
        }
      }
      if ((currentOrder.type === "subscription" || currentOrder.type === "upgrade") && store instanceof D1Store
        && await readSetting<boolean>(store, "notifyTrafficReset", false)) {
        await createUserNotification(store, env, {
          id: `traffic-reset:${currentOrder.id}`, userId: user.id, type: "traffic-reset",
          title: "Traffic quota reset", body: "Your traffic quota was reset after the subscription payment was applied.", emailEnabled: true,
        });
      }
      currentOrder.status = "paid";
      currentOrder.paidAt = new Date().toISOString();
      currentOrder.updatedAt = currentOrder.paidAt;
      await store.put("orders", currentOrder.id, currentOrder);
    }
    settledOrder = currentOrder;
    userId = user.id;
  } finally {
    await store.releaseLease(lockName, lockOwner);
  }
  if (referralReward && store instanceof D1Store) {
    await createUserNotification(store, env, {
      id: `referral-reward:${order.id}`, userId: referralReward.userId, type: "referral-reward",
      title: "Referral reward credited", body: `${referralReward.amountMinor} ${referralReward.currency} was credited to your balance.`,
      emailEnabled: await readSetting<boolean>(store, "notifyReferralReward", false),
    });
  }
  const sync = await syncUserEntitlements(store, env, userId);
  return { order: settledOrder, sync };
}

export async function expirePendingOrders(store: DocumentStore, env: RuntimeEnv, now = new Date()): Promise<number> {
  const expiredAt = now.toISOString();
  const orders: Order[] = [];
  let cursor: string | null = null;
  do {
    const page: Page<Order> = await store.list<Order>("orders", { limit: 100, cursor });
    orders.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  let expiredCount = 0;
  for (const order of orders) {
    if (order.status !== "pending" || !Number.isFinite(Date.parse(order.expiresAt)) || Date.parse(order.expiresAt) > now.getTime()) continue;
    const lockName = `payment-user:${order.userId}`;
    const owner = crypto.randomUUID();
    if (!(await store.acquireLease(lockName, owner, now.getTime() + 60_000))) continue;
    try {
      const current = await store.get<Order>("orders", order.id);
      if (!current || current.status !== "pending" || Date.parse(current.expiresAt) > now.getTime()) continue;
      current.status = "expired";
      current.updatedAt = expiredAt;
      current.metadata = { ...current.metadata, expiredAt };
      await refundOrderBalance(store, current);
      await store.put("orders", current.id, current);
      expiredCount += 1;
      await createUserNotification(store, env, {
        id: `order-expired:${current.id}`, userId: current.userId, type: "order-expired",
        title: "Payment window expired", body: `Order ${current.id} expired before payment was confirmed.`,
        emailEnabled: await readSetting<boolean>(store, "notifyOrderExpired", false),
      });
    } finally {
      await store.releaseLease(lockName, owner);
    }
  }
  return expiredCount;
}
