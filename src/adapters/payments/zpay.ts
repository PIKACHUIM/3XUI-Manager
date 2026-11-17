import type { RuntimeEnv } from "../../env";
import { readBusinessConfig } from "../../services/settings";
import type { Order } from "../../domain/types";
import { md5Hex, verifyEqual } from "./crypto";
import type { CheckoutResult } from "./waffo";

interface ZpayCreateResponse {
  code?: number | string;
  msg?: string;
  O_id?: string;
  payurl?: string;
  payurl2?: string;
  qrcode?: string;
}

interface ZpayQueryResponse {
  code?: number | string;
  status?: number | string;
  out_trade_no?: string;
  money?: string | number;
  pid?: number | string;
}

function cnyFen(value: string): number | null {
  if (!/^\\d+(?:\\.\\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(amount) ? amount : null;
}

function signatureFor(values: Record<string, string>, key: string): string {
  const canonical = Object.entries(values)
    .filter(([name, value]) => name !== "sign" && name !== "sign_type" && value !== "")
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  return md5Hex(`${canonical}${key}`);
}

export function verifyZpaySignature(values: Record<string, string>, key: string, signature: string): boolean {
  return verifyEqual(signatureFor(values, key), signature.toLowerCase());
}

export async function createZpayCheckout(env: RuntimeEnv, order: Order, description: string, amount: string, clientIp: string): Promise<CheckoutResult> {
  const config = await readBusinessConfig(env, ["ZPAY_PID", "ZPAY_KEY", "ZPAY_PAYMENT_TYPE", "PUBLIC_APP_URL"]);
  if (!config.ZPAY_PID || !config.ZPAY_KEY || !config.PUBLIC_APP_URL) throw new Error("Z-PAY requires ZPAY_PID, ZPAY_KEY, and PUBLIC_APP_URL.");
  if (order.currency !== "CNY") throw new Error("Z-PAY checkout is only enabled for CNY orders.");
  const appUrl = new URL(config.PUBLIC_APP_URL);
  if (appUrl.protocol !== "https:") throw new Error("PUBLIC_APP_URL must use HTTPS for payment callbacks.");
  const fields: Record<string, string> = {
    pid: config.ZPAY_PID,
    type: config.ZPAY_PAYMENT_TYPE ?? "alipay",
    out_trade_no: order.id,
    notify_url: `${appUrl.origin}/api/webhooks/zpay`,
    name: description.slice(0, 100),
    money: amount,
    clientip: clientIp,
    device: "pc",
    param: order.id,
    sign_type: "MD5",
  };
  fields.sign = signatureFor(fields, config.ZPAY_KEY);
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  const response = await fetch("https://zpayz.cn/mapi.php", { method: "POST", body: form, signal: AbortSignal.timeout(12000) });
  let result: ZpayCreateResponse;
  try { result = await response.json() as ZpayCreateResponse; } catch { throw new Error("Z-PAY returned invalid JSON."); }
  if (!response.ok || String(result.code) !== "11") throw new Error(`Z-PAY order creation failed: ${(result.msg ?? "unknown error").slice(0, 160)}`);
  const checkoutUrlText = result.payurl ?? result.payurl2;
  if (!checkoutUrlText) throw new Error("Z-PAY response did not include a checkout URL.");
  const checkoutUrl = new URL(checkoutUrlText);
  if (checkoutUrl.protocol !== "https:" || checkoutUrl.username || checkoutUrl.password) throw new Error("Z-PAY returned an unsafe checkout URL.");
  return { checkoutUrl: checkoutUrl.toString(), providerOrderId: result.O_id ?? order.id };
}

export async function verifyAndQueryZpay(env: RuntimeEnv, values: Record<string, string>): Promise<{ orderId: string; amount: string; currency: "CNY"; eventId: string } | null> {
  const config = await readBusinessConfig(env, ["ZPAY_PID", "ZPAY_KEY", "ZPAY_PAYMENT_TYPE", "PUBLIC_APP_URL"]);
  if (!config.ZPAY_PID || !config.ZPAY_KEY || values.pid !== config.ZPAY_PID || values.trade_status !== "TRADE_SUCCESS" || !values.out_trade_no || !values.sign) return null;
  if (!verifyZpaySignature(values, config.ZPAY_KEY, values.sign)) return null;
  const queryUrl = new URL("https://zpayz.cn/api.php");
  queryUrl.searchParams.set("act", "order");
  queryUrl.searchParams.set("pid", config.ZPAY_PID);
  queryUrl.searchParams.set("key", config.ZPAY_KEY);
  queryUrl.searchParams.set("out_trade_no", values.out_trade_no);
  const response = await fetch(queryUrl, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) return null;
  let verified: ZpayQueryResponse;
  try { verified = await response.json() as ZpayQueryResponse; } catch { return null; }
  if (String(verified.code) !== "11" || String(verified.status) !== "1" || verified.out_trade_no !== values.out_trade_no || String(verified.pid) !== config.ZPAY_PID || verified.money === undefined || values.money === undefined) return null;
  const queriedFen = cnyFen(String(verified.money));
  const callbackFen = cnyFen(values.money);
  if (queriedFen === null || callbackFen === null || queriedFen !== callbackFen) return null;
  return { orderId: values.out_trade_no, amount: String(verified.money), currency: "CNY", eventId: `${values.out_trade_no}:${values.trade_no ?? "paid"}` };
}
