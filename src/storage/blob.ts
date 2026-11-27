import type { RuntimeEnv } from "../env";
import type { KvLike } from "./kv";

interface BlobLike {
  get(key: string): Promise<unknown>;
  put?(key: string, value: string): Promise<void>;
  set?(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; cursor?: string; paginate?: boolean; limit?: number }): Promise<unknown>;
}

interface KvLikeBinding {
  get(key: string, type?: "text" | "json"): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{
    keys: Array<{ name: string }>;
    list_complete?: boolean;
    cursor?: string;
  }>;
}

type Resolved = { kind: "blob"; store: BlobLike } | { kind: "kv"; store: KvLikeBinding };

function isBlobLike(value: unknown): value is BlobLike {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BlobLike>;
  return typeof candidate.get === "function" && typeof candidate.delete === "function"
    && (typeof candidate.put === "function" || typeof candidate.set === "function")
    && typeof candidate.list === "function";
}

function isKvLike(value: unknown): value is KvLikeBinding {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<KvLikeBinding>;
  return typeof candidate.get === "function" && typeof candidate.put === "function"
    && typeof candidate.delete === "function" && typeof candidate.list === "function";
}

async function textOf(value: unknown): Promise<string | null> {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && typeof (value as { text?: unknown }).text === "function") {
    return (value as { text: () => Promise<string> }).text();
  }
  return JSON.stringify(value);
}

/**
 * EdgeOne Blob / ESA Blob / EdgeOne KV / ESA KV adapter.
 *
 * EdgeOne exposes Blob through the `@edgeone/pages-blob` SDK, while ESA exposes
 * `ESA_BLOB` (or `ESA_KV`) as a runtime binding. Both are eventually consistent,
 * so this adapter is a document store only; atomic metering and settlement stay
 * on D1.
 */
export class BlobKvAdapter implements KvLike {
  private resolved: Promise<Resolved> | null = null;

  constructor(private readonly env: RuntimeEnv) {}

  private async resolve(): Promise<Resolved> {
    if (this.resolved) return this.resolved;
    this.resolved = (async () => {
      const globals = globalThis as Record<string, unknown>;
      const candidates = [this.env.ESA_BLOB, this.env.EO_BLOB, globals.ESA_BLOB, globals.EO_BLOB];
      for (const candidate of candidates) {
        if (isBlobLike(candidate)) return { kind: "blob", store: candidate };
      }
      const kvCandidates = [this.env.ESA_KV, this.env.EO_KV, globals.ESA_KV, globals.EO_KV];
      for (const candidate of kvCandidates) {
        if (isKvLike(candidate)) return { kind: "kv", store: candidate };
      }
      // EdgeOne Pages Blob uses an SDK rather than a binding. Keep the specifier in
      // a variable so Cloudflare/Vite do not try to bundle the EdgeOne package.
      const specifier = "@edgeone/pages-blob";
      try {
        const module = await import(/* @vite-ignore */ specifier) as { getStore?: (namespace?: string) => unknown };
        const store = module.getStore?.(this.env.EO_BLOB_NAMESPACE || "default");
        if (isBlobLike(store)) return { kind: "blob", store };
      } catch {
        // Fall through to the explicit error below.
      }
      throw new Error("No EdgeOne/ESA Blob or KV binding is configured.");
    })();
    return this.resolved;
  }

  async get(key: string, _type?: "text" | "json"): Promise<unknown> {
    const resolved = await this.resolve();
    if (resolved.kind === "kv") return resolved.store.get(key, "text");
    return textOf(await resolved.store.get(key));
  }

  async put(key: string, value: string): Promise<void> {
    const resolved = await this.resolve();
    if (resolved.kind === "kv") return resolved.store.put(key, value);
    if (resolved.store.put) return resolved.store.put(key, value);
    if (resolved.store.set) return resolved.store.set(key, value);
    throw new Error("The configured blob store does not support writes.");
  }

  async delete(key: string): Promise<void> {
    const resolved = await this.resolve();
    await resolved.store.delete(key);
  }

  async list(options: { prefix: string; limit?: number; cursor?: string }): Promise<{
    keys: Array<{ name: string }>;
    list_complete?: boolean;
    cursor?: string;
  }> {
    const resolved = await this.resolve();
    if (resolved.kind === "kv") return resolved.store.list(options);
    const result = await resolved.store.list({ prefix: options.prefix, cursor: options.cursor, limit: options.limit });
    const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
    if (Array.isArray(record.blobs)) {
      return {
        keys: record.blobs.flatMap((item) => item && typeof item === "object" && typeof (item as { key?: unknown }).key === "string"
          ? [{ name: (item as { key: string }).key }]
          : []),
        list_complete: true,
      };
    }
    const keys = Array.isArray(record.keys)
      ? record.keys.flatMap((item) => typeof item === "string"
        ? [{ name: item }]
        : item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string"
          ? [{ name: (item as { name: string }).name }]
          : [])
      : [];
    return {
      keys,
      list_complete: typeof record.cursor !== "string",
      cursor: typeof record.cursor === "string" ? record.cursor : undefined,
    };
  }
}
