import type { RuntimeEnv } from "../../env";
import { readBusinessConfig } from "../../services/settings";
import type { Order, User } from "../../domain/types";
import { signRsaSha256, verifyRsaSha256 } from "./crypto";

export interface CheckoutResult {
  checkoutUrl: string;
  providerOrderId: string | null;
}

interface WaffoResult {
  paymentRequestId?: string;
  merchantOrderId?: string;
  acquiringOrderId?: string;
  orderStatus?: string;
  orderAction?: string;
  orderAmount?: string | number;
  orderCurrency?: string;
}

interface WaffoEnvelope {
  code?: string;
  msg?: string;
  data?: WaffoResult;
}

export interface WaffoOrderInquiry {
  paymentRequestId: string;
  merchantOrderId: string;
  orderStatus: string;
  orderAmount: string;
  orderCurrency: string;
}

export async function createWaffoCheckout(env: RuntimeEnv, order: Order, user: User, description: string, amount: string): Promise<CheckoutResult> {
  const config = await readBusinessConfig(env, ["WAFFO_API_KEY", "WAFFO_SIGNING_KEY", "WAFFO_PUBLIC_KEY", "WAFFO_MERCHANT_ID", "WAFFO_ENVIRONMENT", "PUBLIC_APP_URL"]);
  const privateKey = config.WAFFO_SIGNING_KEY;
  const publicUrl = config.PUBLIC_APP_URL;
  if (!config.WAFFO_API_KEY || !privateKey || !config.WAFFO_PUBLIC_KEY || !config.WAFFO_MERCHANT_ID || !publicUrl) throw new Error("Waffo requires WAFFO_API_KEY, WAFFO_SIGNING_KEY, WAFFO_PUBLIC_KEY, WAFFO_MERCHANT_ID, and PUBLIC_APP_URL.");
  const appUrl = new URL(publicUrl);
  if (appUrl.protocol !== "https:") throw new Error("PUBLIC_APP_URL must use HTTPS for payment callbacks.");
  const merchantOrderId = order.id;
  const body = {
    paymentRequestId: order.id,
    merchantOrderId,
    orderCurrency: order.currency,
    orderAmount: amount,
    orderDescription: description.slice(0, 120),
    orderRequestedAt: new Date().toISOString(),
    orderExpiredAt: order.expiresAt,
    notifyUrl: `${appUrl.origin}/api/webhooks/waffo`,
    successRedirectUrl: `${appUrl.origin}/?payment=complete`,
    failedRedirectUrl: `${appUrl.origin}/?payment=failed`,
    cancelRedirectUrl: `${appUrl.origin}/?payment=cancelled`,
    merchantInfo: { merchantId: config.WAFFO_MERCHANT_ID },
    userInfo: { userId: user.id, userEmail: user.email, userTerminal: "WEB" },
    paymentInfo: { productName: "ONE_TIME_PAYMENT" },
    goodsInfo: { goodsName: description.slice(0, 120), goodsUrl: `${appUrl.origin}/plans` },
  };
  const bodyText = JSON.stringify(body);
  const environment = config.WAFFO_ENVIRONMENT === "production" ? "https://api.waffo.com" : "https://api-sandbox.waffo.com";
  const path = "/api/v1/order/create";
  const response = await fetch(`${environment}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": config.WAFFO_API_KEY, "X-API-VERSION": "1.0.0", "X-SIGNATURE": await signRsaSha256(bodyText, privateKey) },
    body: bodyText,
    signal: AbortSignal.timeout(12000),
  });
  const raw = await response.text();
  const signature = response.headers.get("X-SIGNATURE");
  if (!response.ok || !signature || !config.WAFFO_PUBLIC_KEY || !(await verifyRsaSha256(raw, signature, config.WAFFO_PUBLIC_KEY))) throw new Error(`Waffo returned an unverified response (HTTP ${response.status}).`);
  let envelope: WaffoEnvelope;
  try { envelope = JSON.parse(raw) as WaffoEnvelope; } catch { throw new Error("Waffo returned invalid JSON."); }
  if (String(envelope.code) !== "0" || !envelope.data?.orderAction) throw new Error(`Waffo order creation failed: ${(envelope.msg ?? "unknown error").slice(0, 160)}`);
  const checkoutUrl = new URL(envelope.data.orderAction);
  if (checkoutUrl.protocol !== "https:") throw new Error("Waffo returned a non-HTTPS checkout URL.");
  return { checkoutUrl: checkoutUrl.toString(), providerOrderId: envelope.data.acquiringOrderId ?? envelope.data.paymentRequestId ?? null };
}

export async function inquireWaffoOrder(env: RuntimeEnv, paymentRequestId: string): Promise<WaffoOrderInquiry> {
  const config = await readBusinessConfig(env, ["WAFFO_API_KEY", "WAFFO_SIGNING_KEY", "WAFFO_PUBLIC_KEY", "WAFFO_MERCHANT_ID", "WAFFO_ENVIRONMENT", "PUBLIC_APP_URL"]);
  const privateKey = config.WAFFO_SIGNING_KEY;
  if (!config.WAFFO_API_KEY || !privateKey || !config.WAFFO_PUBLIC_KEY) throw new Error("Waffo order inquiry requires WAFFO_API_KEY, WAFFO_SIGNING_KEY, and WAFFO_PUBLIC_KEY.");
  const body = JSON.stringify({ paymentRequestId });
  const environment = config.WAFFO_ENVIRONMENT === "production" ? "https://api.waffo.com" : "https://api-sandbox.waffo.com";
  const response = await fetch(`${environment}/api/v1/order/inquiry`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": config.WAFFO_API_KEY, "X-API-VERSION": "1.0.0", "X-SIGNATURE": await signRsaSha256(body, privateKey) },
    body,
    signal: AbortSignal.timeout(12000),
  });
  const raw = await response.text();
  const signature = response.headers.get("X-SIGNATURE");
  if (!response.ok || !signature || !(await verifyRsaSha256(raw, signature, config.WAFFO_PUBLIC_KEY))) throw new Error(`Waffo order inquiry returned an unverified response (HTTP ${response.status}).`);
  let envelope: WaffoEnvelope;
  try { envelope = JSON.parse(raw) as WaffoEnvelope; } catch { throw new Error("Waffo order inquiry returned invalid JSON."); }
  const data = envelope.data;
  if (String(envelope.code) !== "0" || !data || typeof data.paymentRequestId !== "string" || typeof data.merchantOrderId !== "string" || typeof data.orderStatus !== "string" || data.orderAmount === undefined || typeof data.orderCurrency !== "string") {
    throw new Error(`Waffo order inquiry failed: ${(envelope.msg ?? "invalid order data").slice(0, 160)}`);
  }
  if (data.paymentRequestId !== paymentRequestId || data.merchantOrderId !== paymentRequestId) throw new Error("Waffo order inquiry returned a different order.");
  return {
    paymentRequestId: data.paymentRequestId,
    merchantOrderId: data.merchantOrderId,
    orderStatus: data.orderStatus,
    orderAmount: String(data.orderAmount),
    orderCurrency: data.orderCurrency,
  };
}

export async function verifyWaffoWebhook(env: RuntimeEnv, rawBody: string, signature: string | null): Promise<{ orderId: string; succeeded: boolean; final: boolean; amount?: string; currency?: string; eventId: string } | null> {
  const config = await readBusinessConfig(env, ["WAFFO_PUBLIC_KEY"]);
  if (!signature || !config.WAFFO_PUBLIC_KEY || !(await verifyRsaSha256(rawBody, signature, config.WAFFO_PUBLIC_KEY))) return null;
  try {
    const event = JSON.parse(rawBody) as { eventType?: string; result?: WaffoResult & { merchantOrderId?: string; orderStatus?: string; orderAmount?: string | number; orderCurrency?: string; paymentRequestId?: string } };
    if (event.eventType !== "PAYMENT_NOTIFICATION" || !event.result?.merchantOrderId || !event.result.orderStatus) return null;
    return {
      orderId: event.result.merchantOrderId,
      succeeded: event.result.orderStatus === "PAY_SUCCESS",
      final: event.result.orderStatus === "PAY_SUCCESS" || event.result.orderStatus === "ORDER_CLOSE",
      ...(event.result.orderAmount !== undefined ? { amount: String(event.result.orderAmount) } : {}),
      ...(event.result.orderCurrency ? { currency: event.result.orderCurrency } : {}),
      eventId: event.result.paymentRequestId ?? event.result.merchantOrderId,
    };
  } catch {
    return null;
  }
}
