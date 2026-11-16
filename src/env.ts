type SecretBindings = {
  STORAGE_DRIVER?: string;
  SESSION_SIGNING_KEY?: string;
  APP_ENCRYPTION_KEY?: string;
  ADMIN_BOOTSTRAP_TOKEN?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  WAFFO_API_KEY?: string;
  WAFFO_SIGNING_KEY?: string;
  WAFFO_PUBLIC_KEY?: string;
  WAFFO_MERCHANT_ID?: string;
  WAFFO_ENVIRONMENT?: "sandbox" | "production";
  DODO_ENVIRONMENT?: "test_mode" | "live_mode";
  DODO_TOPUP_PRODUCT_ID?: string;
  ZPAY_PAYMENT_TYPE?: "alipay" | "wxpay";
  DODO_API_KEY?: string;
  DODO_WEBHOOK_KEY?: string;
  ZPAY_PID?: string;
  ZPAY_KEY?: string;
  PUBLIC_APP_URL?: string;
};

export type RuntimeEnv = Env & SecretBindings;
