import type { RuntimeEnv } from "../env";
import { BlobKvAdapter } from "./blob";
import { D1Store } from "./d1";
import { KvStore, type KvLike } from "./kv";
import { MySqlKv } from "./mysql";
import { StorageUnavailableError, type DocumentStore } from "./store";

/**
 * Storage is selected from the runtime:
 * - Cloudflare: D1 by default.
 * - Vercel / Node: remote MySQL when MYSQL_* is configured.
 * - EdgeOne / ESA: Blob or KV bindings.
 *
 * Blob/KV and the MySQL document store are limited to document operations. Atomic
 * traffic accounting and payment settlement remain D1-only until a relational
 * MySQL implementation is added.
 */
export function getStore(env: RuntimeEnv): DocumentStore {
  const requested = (env.STORAGE_DRIVER ?? "").toLowerCase();
  const hasD1 = Boolean(env.DB);
  const hasMysql = Boolean(env.MYSQL_URLS || env.MYSQL_HOST);
  const hasKv = Boolean(env.APP_KV || env.ESA_KV || env.EO_KV);
  const hasBlob = Boolean(env.ESA_BLOB || env.EO_BLOB);
  const driver = requested || (hasD1 ? "d1" : hasMysql ? "mysql" : hasKv ? "kv" : hasBlob ? "blob" : "d1");

  if (driver === "d1") {
    if (!env.DB) throw new StorageUnavailableError(driver);
    return new D1Store(env.DB);
  }
  if (driver === "kv") {
    const kv = env.APP_KV ?? env.ESA_KV ?? env.EO_KV;
    if (!kv) throw new StorageUnavailableError(driver);
    return new KvStore(kv as unknown as KvLike);
  }
  if (driver === "blob") {
    return new KvStore(new BlobKvAdapter(env));
  }
  if (driver === "mysql") {
    return new KvStore(new MySqlKv(env));
  }
  throw new StorageUnavailableError(driver);
}

export { StorageUnavailableError } from "./store";
export type { DocumentStore, ListOptions, Page } from "./store";
