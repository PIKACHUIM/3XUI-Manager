import { generateKeyPairSync, sign as signRsa } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Order, User } from "../../domain/types";
import type { RuntimeEnv } from "../../env";
import { md5Hex } from "./crypto";
import { createWaffoCheckout, verifyWaffoWebhook } from "./waffo";
import { createZpayCheckout, verifyZpaySignature } from "./zpay";

const createRsaKeyPair = () => generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const signPayload = (payload: string, privateKey: string) => signRsa("RSA-SHA256", Buffer.from(payload), privateKey).toString("base64");

afterEach(() => vi.unstubAllGlobals());

describe("Z-PAY adapter", () => {
  it("matches the documented MD5 signing format", () => {
    expect(md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
    const fields = { pid: "merchant", money: "12.30", out_trade_no: "order-1", sign_type: "MD5" };
    const canonical = "money=12.30&out_trade_no=order-1&pid=merchant";
    expect(verifyZpaySignature(fields, "secret", md5Hex(`${canonical}secret`))).toBe(true);
    expect(verifyZpaySignature(fields, "secret", "0".repeat(32))).toBe(false);
  });

  it("accepts the documented success code and forwards the validated client IP", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as FormData;
      expect(form.get("clientip")).toBe("203.0.113.8");
      return new Response(JSON.stringify({ code: 11, payurl: "https://pay.example.test/order/1", O_id: "provider-1" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const env = { ZPAY_PID: "merchant", ZPAY_KEY: "secret", PUBLIC_APP_URL: "https://manager.example.test" } as unknown as RuntimeEnv;
    const order = { id: "order-1", currency: "CNY" } as Order;

    await expect(createZpayCheckout(env, order, "Plan", "12.30", "203.0.113.8")).resolves.toEqual({
      checkoutUrl: "https://pay.example.test/order/1",
      providerOrderId: "provider-1",
    });
  });
});

describe("Waffo adapter", () => {
  it("creates an order using the documented fields and verifies the signed response", async () => {
    const merchantKeys = createRsaKeyPair();
    const waffoKeys = createRsaKeyPair();
    const responseBody = JSON.stringify({ code: 0, msg: "success", data: { paymentRequestId: "12345678901234567890123456789012", acquiringOrderId: "acquiring-1", orderAction: "https://checkout.waffo.test/pay/1" } });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://api-sandbox.waffo.com/api/v1/order/create");
      const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(requestBody).toMatchObject({
        paymentRequestId: "12345678901234567890123456789012",
        merchantOrderId: "12345678901234567890123456789012",
        orderCurrency: "USD",
        orderAmount: "12.30",
        notifyUrl: "https://manager.example.test/api/webhooks/waffo",
        merchantInfo: { merchantId: "merchant-1" },
        paymentInfo: { productName: "ONE_TIME_PAYMENT" },
      });
      expect(new Headers(init?.headers).get("X-SIGNATURE")).toBeTruthy();
      return new Response(responseBody, { status: 200, headers: { "X-SIGNATURE": signPayload(responseBody, waffoKeys.privateKey) } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const env = {
      WAFFO_API_KEY: "api-key",
      WAFFO_SIGNING_KEY: merchantKeys.privateKey,
      WAFFO_PUBLIC_KEY: waffoKeys.publicKey,
      WAFFO_MERCHANT_ID: "merchant-1",
      WAFFO_ENVIRONMENT: "sandbox",
      PUBLIC_APP_URL: "https://manager.example.test",
    } as unknown as RuntimeEnv;
    const order = { id: "12345678901234567890123456789012", currency: "USD", expiresAt: "2026-11-14T17:00:00.000Z" } as Order;
    const user = { id: "user-1", email: "user@example.test" } as User;

    await expect(createWaffoCheckout(env, order, user, "Plan", "12.30")).resolves.toEqual({
      checkoutUrl: "https://checkout.waffo.test/pay/1",
      providerOrderId: "acquiring-1",
    });
  });

  it.each([
    ["PAY_SUCCESS", true, true],
    ["ORDER_CLOSE", false, true],
    ["PAY_IN_PROGRESS", false, false],
  ])("maps the documented %s order status", async (orderStatus, succeeded, final) => {
    const keys = createRsaKeyPair();
    const env = { WAFFO_PUBLIC_KEY: keys.publicKey } as unknown as RuntimeEnv;
    const rawBody = JSON.stringify({
      eventType: "PAYMENT_NOTIFICATION",
      result: {
        merchantOrderId: "order-1",
        paymentRequestId: "request-1",
        orderStatus,
        orderAmount: "12.30",
        orderCurrency: "USD",
      },
    });

    await expect(verifyWaffoWebhook(env, rawBody, signPayload(rawBody, keys.privateKey))).resolves.toMatchObject({
      orderId: "order-1",
      eventId: "request-1",
      succeeded,
      final,
      amount: "12.30",
      currency: "USD",
    });
  });

  it("rejects an invalid signature or an unrelated event type", async () => {
    const keys = createRsaKeyPair();
    const env = { WAFFO_PUBLIC_KEY: keys.publicKey } as unknown as RuntimeEnv;
    const rawBody = JSON.stringify({ eventType: "REFUND_NOTIFICATION", result: { merchantOrderId: "order-1", orderStatus: "PAY_SUCCESS" } });

    await expect(verifyWaffoWebhook(env, rawBody, "invalid-signature")).resolves.toBeNull();
    await expect(verifyWaffoWebhook(env, rawBody, signPayload(rawBody, keys.privateKey))).resolves.toBeNull();
  });
});
