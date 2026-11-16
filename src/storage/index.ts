import type { RuntimeEnv } from "../env";
import { D1Store } from "./d1";
import { KvStore } from "./kv";
import { StorageUnavailableError, type DocumentStore } from "./store";

export function getStore(env: RuntimeEnv): DocumentStore {
  const driver = env.STORAGE_DRIVER?.toLocaleLowerCase() ?? "d1";
  if (driver === "kv") {
    if (!env.APP_KV) throw new StorageUnavailableError(driver);
    return new KvStore(env.APP_KV);
  }
  if (driver === "d1") {
    if (!env.DB) throw new StorageUnavailableError(driver);
    return new D1Store(env.DB);
  }
  throw new StorageUnavailableError(driver);
}

export { StorageUnavailableError } from "./store";
export type { DocumentStore, ListOptions, Page } from "./store";
