import { Hono } from "hono";
import { readBusinessConfig } from "../services/settings";
import type { Context } from "hono";
import type { ApiEnv } from "./context";
import { requireUser, validateSameOrigin } from "./context";
import type { Order } from "../domain/types";
import type { DocumentStore, Page } from "../storage/store";
import { createCheckout, moneyToMinor, settleFailedOrder, settlePaidOrder } from "../services/billing";
import { inquireWaffoOrder, verifyWaffoWebhook } from "../adapters/payments/waffo";
import { signRsaSha256 } from "../adapters/payments/crypto";
import { D1Store } from "../storage/d1";

const payments = new Hono<ApiEnv>();
const webhooks = new Hono<ApiEnv>();
payments.use("*", async (c, next) => {
  if (c.req.method === "POST" && !validateSameOrigin(c.req.raw)) return c.json({ error: "Request origin is not allowed." }, 403);
  await next();
});

type ProviderEvent = {
  orderId: string;
  eventId: string;
  succeeded: boolean;
  final?: boolean;
  amountMinor?: number;
  amount?: string;
  currency?: string;
};

async function parseObject(c: Context<ApiEnv>): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await c.req.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function findOrder(store: DocumentStore, id: string): Promise<Order | null> {
  const direct = await store.get<Order>("orders", id);
  if (direct) return direct;
  let cursor: string | null = null;
  do {
    const page: Page<Order> = await store.list<Order>("orders", { limit: 100, cursor });
    const match = page.items.find((order) => order.id === id || order.metadata?.merchantOrderId === id);
    if (match) return match;
    cursor = page.cursor;
  } while (cursor);
  return null;
}

async function processFinalEvent(c: Context<ApiEnv>, provider: string, event: ProviderEvent): Promise<Response | null> {
  if (event.final === false) return null;
  const store = c.get("store");
  const order = await findOrder(store, event.orderId);
  if (!order || order.provider !== provider) return c.json({ error: "Matching payment order was not found." }, 404);
  if (order.status === "paid") return null;
  if (event.currency?.toUpperCase() !== order.currency.toUpperCase()) return c.json({ error: "Payment currency does not match the order." }, 422);
  const amountMinor = event.amountMinor ?? (event.amount ? moneyToMinor(event.amount, order.currency) : null);
  if (amountMinor === null || amountMinor === undefined || amountMinor !== order.amountMinor) return c.json({ error: "Payment amount does not match the order." }, 422);
  if (order.status !== "pending") {
    if ((order.status === "failed" || order.status === "expired") && !event.succeeded) return null;
    if (provider === "waffo" && event.succeeded && (order.status === "failed" || order.status === "expired")) {
      if (!(store instanceof D1Store)) return c.json({ error: "Payment reconciliation requires D1 atomic storage; this deployment uses a non-D1 backend." }, 503);
      try {
        const inquiry = await inquireWaffoOrder(c.env, order.id);
        const inquiryAmountMinor = moneyToMinor(inquiry.orderAmount, order.currency);
        if (inquiry.orderCurrency.toUpperCase() !== order.currency.toUpperCase() || inquiryAmountMinor !== order.amountMinor) throw new Error("Waffo order inquiry amount does not match the local order.");
        if (inquiry.orderStatus === "ORDER_CLOSE") return null;
        if (inquiry.orderStatus !== "PAY_SUCCESS") throw new Error("Waffo order inquiry did not return a terminal status.");
        const { sync } = await settlePaidOrder(store, c.env, order, inquiry.paymentRequestId, "PAY_SUCCESS");
        if (sync.status !== "synced") console.error(JSON.stringify({ event: "payment_settled_sync_pending", orderId: order.id, status: sync.status, failedNodes: sync.failed }));
        return null;
      } catch (error) {
        console.error(JSON.stringify({ event: "payment_reconciliation_failed", orderId: order.id, message: error instanceof Error ? error.message : "unknown" }));
        return c.json({ error: "Payment reconciliation is temporarily unavailable." }, 503);
      }
    }
    return c.json({ error: "Payment order is no longer payable." }, 409);
  }
  if (!event.succeeded) {
    if (!(store instanceof D1Store)) return c.json({ error: "Payment failure settlement requires D1 atomic storage; this deployment uses a non-D1 backend." }, 503);
    try {
      await settleFailedOrder(store, order, event.eventId);
      return null;
    } catch (error) {
      console.error(JSON.stringify({ event: "payment_failure_settlement_failed", orderId: order.id, message: error instanceof Error ? error.message : "unknown" }));
      return c.json({ error: "Payment failure processing is temporarily unavailable." }, 503);
    }
  }
  if (!(store instanceof D1Store)) return c.json({ error: "Payment settlement requires D1 atomic storage; this deployment uses a non-D1 backend." }, 503);
  try {
    const { sync } = await settlePaidOrder(store, c.env, order, event.eventId);
    if (sync.status !== "synced") console.error(JSON.stringify({ event: "payment_settled_sync_pending", orderId: order.id, status: sync.status, failedNodes: sync.failed }));
    return null;
  } catch (error) {
    console.error(JSON.stringify({ event: "payment_settlement_failed", orderId: order.id, message: error instanceof Error ? error.message : "unknown" }));
    return c.json({ error: "Payment settlement is temporarily unavailable." }, 503);
  }
}

async function waffoAcknowledgement(env: ApiEnv["Bindings"], message: "success" | "failed"): Promise<Response> {
  const config = await readBusinessConfig(env, ["WAFFO_SIGNING_KEY"]);
  if (!config.WAFFO_SIGNING_KEY) return new Response(JSON.stringify({ message: "failed" }), { status: 503, headers: { "Content-Type": "application/json" } });
  const body = JSON.stringify({ message });
  const signature = await signRsaSha256(body, config.WAFFO_SIGNING_KEY);
  return new Response(body, { status: 200, headers: { "Content-Type": "application/json", "X-SIGNATURE": signature } });
}

function publicOrder(order: Order): Omit<Order, "metadata"> {
  const { metadata: _metadata, ...safe } = order;
  return safe;
}

payments.post("/checkout", requireUser, async (c) => {
  if (!(c.get("store") instanceof D1Store)) return c.json({ error: "Payment checkout is disabled on non-D1 storage because settlement locking is not atomic." }, 503);
  const body = await parseObject(c);
  if (!body || (body.type !== "topup" && body.type !== "subscription" && body.type !== "upgrade") || body.provider !== "waffo") {
    return c.json({ error: "Only Waffo checkout is supported." }, 422);
  }
  const input = {
    type: body.type,
    provider: body.provider,
    ...(typeof body.planId === "string" ? { planId: body.planId } : {}),
    ...(typeof body.amountMinor === "number" ? { amountMinor: body.amountMinor } : {}),
    ...(typeof body.currency === "string" ? { currency: body.currency } : {}),
  } as const;
  try {
    const result = await createCheckout(c.get("store"), c.env, c.get("user"), input);
    return c.json({ order: result.order ? publicOrder(result.order) : null, checkoutUrl: result.checkoutUrl, appliedWithoutPayment: result.appliedWithoutPayment ?? false, balanceAppliedMinor: result.balanceAppliedMinor ?? 0 }, result.order ? 201 : 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Payment checkout could not be created.";
    const status = /Another account update is being processed/.test(message) ? 409 : /unavailable|eligible|currency|amount|plan|select|upgrade|Dodo|Z-PAY/.test(message) ? 422 : 502;
    return c.json({ error: message }, status);
  }
});

webhooks.post("/waffo", async (c) => {
  const rawBody = await c.req.text();
  const event = await verifyWaffoWebhook(c.env, rawBody, c.req.header("X-SIGNATURE") ?? null);
  if (!event) return waffoAcknowledgement(c.env, "failed");
  if (!event.final) return waffoAcknowledgement(c.env, "success");
  const result = await processFinalEvent(c, "waffo", { ...event, final: true });
  return waffoAcknowledgement(c.env, result ? "failed" : "success");
});


export { payments, webhooks };
