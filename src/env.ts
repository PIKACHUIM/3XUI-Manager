type SecretBindings = {
  STORAGE_DRIVER?: string;
  SESSION_SIGNING_KEY?: string;
  APP_ENCRYPTION_KEY?: string;
  ADMIN_BOOTSTRAP_TOKEN?: string;
  CRON_SECRET?: string;
};

/** Storage/runtime values supplied by EdgeOne, ESA, Vercel or a Node container. */
type PlatformBindings = {
  MYSQL_URLS?: string;
  MYSQL_HOST?: string;
  MYSQL_PORT?: string;
  MYSQL_USER?: string;
  MYSQL_PASS?: string;
  MYSQL_NAME?: string;
  ESA_BLOB?: unknown;
  ESA_KV?: unknown;
  EO_BLOB?: unknown;
  EO_KV?: unknown;
  EO_BLOB_NAMESPACE?: string;
};

export type RuntimeEnv = Env & SecretBindings & PlatformBindings;
