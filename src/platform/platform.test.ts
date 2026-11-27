import { describe, expect, it } from "vitest";
import app from "../app";
import type { RuntimeEnv } from "../env";
import { getStore } from "../storage";
import { KvStore, type KvLike } from "../storage/kv";

class MemoryKv implements KvLike {
  data = new Map<string, string>();
  async get(key: string) { return this.data.get(key) ?? null; }
  async put(key: string, value: string) { this.data.set(key, value); }
  async delete(key: string) { this.data.delete(key); }
  async list(options: { prefix: string; limit?: number; cursor?: string }) {
    const keys = [...this.data.keys()].filter((key) => key.startsWith(options.prefix)).sort();
    return { keys: keys.slice(0, options.limit ?? 100).map((name) => ({ name })), list_complete: true };
  }
}

describe("platform storage and app entry", () => {
  it("selects a document store from a KV binding", async () => {
    const env = { STORAGE_DRIVER: "kv", APP_KV: new MemoryKv() } as unknown as RuntimeEnv;
    const store = getStore(env);
    expect(store).toBeInstanceOf(KvStore);
    await store.put("nodes", "n1", { id: "n1" });
    expect(await store.get("nodes", "n1")).toEqual({ id: "n1" });
  });

  it("serves health with document-storage capabilities on non-D1", async () => {
    const env = { STORAGE_DRIVER: "kv", APP_KV: new MemoryKv() } as unknown as RuntimeEnv;
    const response = await app.fetch(new Request("https://manager.test/api/health"), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      storage: "document",
      capabilities: { trafficMetering: false, quotaEnforcement: false, atomicPaymentSettlement: false },
    });
  });
});
