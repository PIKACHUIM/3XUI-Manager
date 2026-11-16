import type { RuntimeEnv } from "../../env";
import type { Order, Plan, User } from "../../domain/types";
import { verifyHmacSha256 } from "./crypto";
import type { CheckoutResult } from "./waffo";

interface DodoCheckoutResponse {
  session_id?: string;
  checkout_url?: string | null;
}

function dodoBaseUrl(env: RuntimeEnv): string {
  return env.DODO_ENVIRONMENT === "test_mode" ? "https://test.dodopayments.com" : "https://live.dodopayments.com";
}

export async function createDodoCheckout(env: RuntimeEnv, order: Order, user: User, plan: Plan | null): Promise<CheckoutResult> {
  if (!env.DODO_API_KEY) throw new Error("Dodo Payments requires DODO_API_KEY.");
  const productId = plan?.dodoProductId ?? (order.type === "topup" ? env.DODO_TOPUP_PRODUCT_ID : undefined);
  if (!productId) throw new Error("Configure a Dodo product ID for this plan before enabling Dodo checkout.");
  if (order.type === "upgrade" && plan && order.amountMinor !== plan.priceMinor) throw new Error("Dodo cannot represent this discounted upgrade price with the configured fixed-price product. Use a provider that supports custom order amounts or configure a matching Dodo product.");
  if (order.type === "topup") throw new Error("Dodo top-ups require a fixed product price matching the requested amount; custom top-up pricing is not enabled.");
  const appUrl = env.PUBLIC_APP_URL;
  if (!appUrl || new URL(appUrl).protocol !== "https:") throw new Error("PUBLIC_APP_URL must use HTTPS for payment callbacks.");
  const response = await fetch(`${dodoBaseUrl(env)}/checkouts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.DODO_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      product_cart: [{ product_id: productId, quantity: 1 }],
      customer: { email: user.email },
      metadata: { order_id: order.id, local_user_id: user.id, local_plan_id: order.planId ?? "" },
      return_url: `${new URL(appUrl).origin}/?payment=complete`,
    }),
    signal: AbortSignal.timeout(12000),
  });
  let result: DodoCheckoutResponse & { message?: string; code?: string };
  try { result = await response.json() as DodoCheckoutResponse & { message?: string; code?: string }; } catch { throw new Error("Dodo Payments returned invalid JSON."); }
  if (!response.ok || !result.session_id || !result.checkout_url) throw new Error(`Dodo checkout creation failed: ${(result.message ?? result.code ?? `HTTP ${response.status}`).slice(0, 160)}`);
  const checkoutUrl = new URL(result.checkout_url);
  if (checkoutUrl.protocol !== "https:" || !(checkoutUrl.hostname === "dodopayments.com" || checkoutUrl.hostname.endsWith(".dodopayments.com"))) throw new Error("Dodo returned an unsafe checkout URL.");
  return { checkoutUrl: checkoutUrl.toString(), providerOrderId: result.session_id };
}

export async function verifyDodoWebhook(rawBody: string, headers: Headers, secret: string | undefined): Promise<{ orderId: string; eventId: string; succeeded: boolean; final: boolean; amountMinor?: number; currency?: string } | null> {
  const id = headers.get("webhook-id") ?? "";
  const timestamp = headers.get("webhook-timestamp") ?? "";
  const signature = headers.get("webhook-signature") ?? "";
  if (!secret || !id || !timestamp || !signature || !(await verifyHmacSha256(rawBody, { id, timestamp, signature }, secret))) return null;
  try {
    const event = JSON.parse(rawBody) as {
      type?: string;
      event_type?: string;
      data?: { metadata?: Record<string, unknown>; total_amount?: number; amount?: number; currency?: string; payment_id?: string; payment_status?: string };
    };
    const data = event.data;
    const orderId = typeof data?.metadata?.order_id === "string" ? data.metadata.order_id : typeof data?.metadata?.orderId === "string" ? data.metadata.orderId : "";
    if (!orderId) return null;
    const amount = data?.total_amount ?? data?.amount;
    const type = event.type ?? event.event_type ?? "";
    return {
      orderId,
      eventId: id,
      succeeded: type === "payment.succeeded" && data?.payment_status !== "failed",
      final: type === "payment.succeeded", 
      ...(typeof amount === "number" && Number.isSafeInteger(amount) ? { amountMinor: amount } : {}),
      ...(data?.currency ? { currency: data.currency } : {}),
    };
  } catch {
    return null;
  }
}
