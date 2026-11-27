import { describe, expect, it } from "vitest";
import type { RuntimeEnv } from "../env";
import { BlobKvAdapter } from "./blob";
import { KvStore, type KvLike } from "./kv";

class MemoryKv implements KvLike {
  data = new Map<string, string>();

  async get(key: string): Promise<unknown> {
    return this.data.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async list(options: { prefix: string; limit?: number; cursor?: string }) {
    const keys = [...this.data.keys()].filter((key) => key.startsWith(options.prefix) && key > (options.cursor ?? "")).sort();
    const limit = options.limit ?? 100;
    const page = keys.slice(0, limit);
    return { keys: page.map((name) => ({ name })), list_complete: keys.length <= limit, cursor: page.at(-1) };
  }
}

describe("KvStore", () => {
  it("stores JSON records and filters list results by document prefix", async () => {
    const store = new KvStore(new MemoryKv());
    await store.put("users", "u1", { id: "u1", email: "one@example.test" });
    await store.put("users", "u2", { id: "u2", email: "two@example.test" });
    await store.put("plans", "p1", { id: "p1" });

    expect(await store.get("users", "u1")).toMatchObject({ email: "one@example.test" });
    expect((await store.list("users")).items).toHaveLength(2);
    expect((await store.list("users", { prefix: "u2" })).items).toEqual([{ id: "u2", email: "two@example.test" }]);
    expect(await store.has("users", "missing")).toBe(false);
  });

  it("keeps the non-atomic lease behavior used by document stores", async () => {
    const store = new KvStore(new MemoryKv());
    expect(await store.acquireLease("job", "owner-a", Date.now() + 10_000)).toBe(true);
    expect(await store.acquireLease("job", "owner-b", Date.now() + 10_000)).toBe(false);
    await store.releaseLease("job", "owner-b");
    expect(await store.acquireLease("job", "owner-b", Date.now() + 10_000)).toBe(false);
    await store.releaseLease("job", "owner-a");
    expect(await store.acquireLease("job", "owner-b", Date.now() + 10_000)).toBe(true);
  });
});

describe("BlobKvAdapter", () => {
  it("adapts an ESA-style blob binding to the document store", async () => {
    const data = new Map<string, string>();
    const blob = {
      async get(key: string) { const value = data.get(key); return value === undefined ? null : { text: async () => value }; },
      async put(key: string, value: string) { data.set(key, value); },
      async delete(key: string) { data.delete(key); },
      async list(options: { prefix: string; cursor?: string }) {
        const keys = [...data.keys()].filter((key) => key.startsWith(options.prefix)).sort();
        return { keys: keys.map((name) => ({ name })), cursor: undefined };
      },
    };
    const env = { ESA_BLOB: blob } as unknown as RuntimeEnv;
    const store = new KvStore(new BlobKvAdapter(env));
    await store.put("nodes", "n1", { id: "n1", name: "Tokyo" });

    expect(await store.get("nodes", "n1")).toEqual({ id: "n1", name: "Tokyo" });
    expect((await store.list("nodes")).items).toEqual([{ id: "n1", name: "Tokyo" }]);
  });

  it("adapts an EdgeOne-style KV binding", async () => {
    const kv = new MemoryKv();
    const env = { EO_KV: kv } as unknown as RuntimeEnv;
    const store = new KvStore(new BlobKvAdapter(env));
    await store.put("plans", "p1", { id: "p1" });
    expect(await store.get("plans", "p1")).toEqual({ id: "p1" });
  });
});
