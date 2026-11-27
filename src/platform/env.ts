import type { RuntimeEnv } from "../env";

type ProcessLike = { env?: Record<string, string | undefined> };

/** Vercel and other Node runtimes expose configuration through process.env. */
export function processEnv(): RuntimeEnv {
  const env = (globalThis as { process?: ProcessLike }).process?.env ?? {};
  const driver = env.STORAGE_DRIVER || (env.MYSQL_URLS || env.MYSQL_HOST ? "mysql" : "d1");
  return { ...env, STORAGE_DRIVER: driver } as unknown as RuntimeEnv;
}

/** EdgeOne/ESA pass bindings as the second `fetch(request, env)` argument. */
export function platformEnv(env: Record<string, unknown> | undefined, fallbackDriver: "blob" | "kv"): RuntimeEnv {
  const source = env ?? {};
  const driver = typeof source.STORAGE_DRIVER === "string" && source.STORAGE_DRIVER
    ? source.STORAGE_DRIVER
    : fallbackDriver;
  return { ...source, STORAGE_DRIVER: driver } as unknown as RuntimeEnv;
}
