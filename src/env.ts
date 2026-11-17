type SecretBindings = {
  STORAGE_DRIVER?: string;
  SESSION_SIGNING_KEY?: string;
  APP_ENCRYPTION_KEY?: string;
  ADMIN_BOOTSTRAP_TOKEN?: string;
};

export type RuntimeEnv = Env & SecretBindings;
