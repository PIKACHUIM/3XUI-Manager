import type { RuntimeEnv } from "../env";
import { getStore } from "../storage";
import type { DocumentStore } from "../storage/store";
import { readSetting } from "../domain/defaults";
import { decryptSecret, encryptSecret } from "../domain/security";

export const businessSettingNames = {
  PUBLIC_APP_URL: "publicAppUrl",
  TURNSTILE_SITE_KEY: "turnstileSiteKey", TURNSTILE_SECRET_KEY: "turnstileSecretKey",
  RESEND_API_KEY: "resendApiKey", RESEND_FROM: "resendFrom",
  WAFFO_API_KEY: "waffoApiKey", WAFFO_SIGNING_KEY: "waffoSigningKey", WAFFO_PUBLIC_KEY: "waffoPublicKey",
  WAFFO_MERCHANT_ID: "waffoMerchantId", WAFFO_ENVIRONMENT: "waffoEnvironment",
  DODO_API_KEY: "dodoApiKey", DODO_WEBHOOK_KEY: "dodoWebhookKey", DODO_ENVIRONMENT: "dodoEnvironment", DODO_TOPUP_PRODUCT_ID: "dodoTopupProductId",
  ZPAY_PID: "zpayPid", ZPAY_KEY: "zpayKey", ZPAY_PAYMENT_TYPE: "zpayPaymentType",
} as const;
export const secretSettingKeys = new Set<string>(["turnstileSecretKey", "resendApiKey", "waffoApiKey", "waffoSigningKey", "dodoApiKey", "dodoWebhookKey", "zpayKey"]);
export const businessSettingKeys = new Set<string>(Object.values(businessSettingNames));
export type BusinessConfig = Partial<Record<keyof typeof businessSettingNames, string>>;
const encryptedPrefix = "encrypted:v1:";

/** Business configuration has no environment fallback, including in scheduled jobs. */
export async function readBusinessConfig(env: RuntimeEnv, keys: readonly (keyof BusinessConfig)[], store: DocumentStore = getStore(env)): Promise<BusinessConfig> {
  const config: BusinessConfig = {};
  await Promise.all(keys.map(async (name) => {
    const key = businessSettingNames[name];
    const value = await readSetting<unknown>(store, key, "");
    if (typeof value !== "string" || !value) return;
    if (secretSettingKeys.has(key)) {
      if (!value.startsWith(encryptedPrefix)) throw new Error(`System setting ${key} must be encrypted. Save it again in system settings.`);
      if (!env.APP_ENCRYPTION_KEY || env.APP_ENCRYPTION_KEY.length < 32) throw new Error("APP_ENCRYPTION_KEY must contain at least 32 characters.");
      config[name] = await decryptSecret(value.slice(encryptedPrefix.length), env.APP_ENCRYPTION_KEY);
    } else config[name] = value;
  }));
  return config;
}

export function validateBusinessSetting(key: string, value: unknown): string | null {
  if (!businessSettingKeys.has(key)) return null;
  if (secretSettingKeys.has(key) && value === null) return null;
  if (typeof value !== "string" || value.length > 16384) return `${key} must be a string of at most 16384 characters.`;
  if (!value) return null;
  if (key === "publicAppUrl") {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") return "publicAppUrl must be an HTTPS origin without credentials, path, query or fragment.";
    } catch { return "publicAppUrl must be an HTTPS origin."; }
  }
  const enums: Record<string, string[]> = { waffoEnvironment: ["sandbox", "production"], dodoEnvironment: ["test_mode", "live_mode"], zpayPaymentType: ["alipay", "wxpay"] };
  if (enums[key] && !enums[key].includes(value)) return `${key} is invalid.`;
  if (key === "resendFrom" && (!/^[^\r\n]+@[^\r\n]+$/.test(value))) return "resendFrom must be an email sender address.";
  return null;
}

/** Prepare every encrypted value before the caller writes any setting. Empty secrets mean keep. */
export async function prepareBusinessSettings(body: Record<string, unknown>, env: RuntimeEnv): Promise<Record<string, unknown>> {
  const prepared = { ...body };
  for (const [key, value] of Object.entries(body)) {
    if (!secretSettingKeys.has(key)) continue;
    if (value === "") delete prepared[key];
    else if (value === null) prepared[key] = "";
    else prepared[key] = encryptedPrefix + await encryptSecret(value as string, env.APP_ENCRYPTION_KEY ?? "");
  }
  return prepared;
}

export function publicSettings(settings: Record<string, unknown>): { settings: Record<string, unknown>; secretConfigured: Record<string, boolean> } {
  const safe = { ...Object.fromEntries([...businessSettingKeys].map((key) => [key, ""])), ...settings };
  const secretConfigured: Record<string, boolean> = {};
  for (const key of secretSettingKeys) {
    secretConfigured[key] = typeof safe[key] === "string" && Boolean(safe[key]);
    safe[key] = "";
  }
  return { settings: safe, secretConfigured };
}
