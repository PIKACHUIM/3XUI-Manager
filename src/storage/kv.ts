import type { DocumentStore, ListOptions, Page } from "./store";

const keyPrefix = "3xu:record:";

/** The smallest KV surface shared by Cloudflare KV, EdgeOne KV and ESA KV. */
export interface KvLike {
  get(key: string, type?: "text" | "json"): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; limit?: number; cursor?: string }): Promise<{
    keys: Array<{ name: string }>;
    list_complete?: boolean;
    cursor?: string;
  }>;
}

function parseRecord<T>(raw: unknown): T | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return raw as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export class KvStore implements DocumentStore {
  constructor(private readonly kv: KvLike) {}

  private key(collection: string, id: string): string {
    return `${keyPrefix}${encodeURIComponent(collection)}:${encodeURIComponent(id)}`;
  }

  async get<T>(collection: string, id: string): Promise<T | null> {
    return parseRecord<T>(await this.kv.get(this.key(collection, id), "text"));
  }

  async put<T>(collection: string, id: string, value: T): Promise<void> {
    await this.kv.put(this.key(collection, id), JSON.stringify(value));
  }

  async delete(collection: string, id: string): Promise<void> {
    await this.kv.delete(this.key(collection, id));
  }

  async list<T>(collection: string, options: ListOptions = {}): Promise<Page<T>> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const prefix = `${keyPrefix}${encodeURIComponent(collection)}:`;
    const result = await this.kv.list({ prefix, limit, cursor: options.cursor ?? undefined });
    const keys = result.keys.filter((item) => {
      if (!options.prefix) return true;
      try {
        return decodeURIComponent(item.name.slice(prefix.length)).startsWith(options.prefix);
      } catch {
        return false;
      }
    });
    const values = await Promise.all(keys.map((item) => this.kv.get(item.name, "text")));
    return {
      items: values.map((value) => parseRecord<T>(value)).filter((value): value is T => value !== null),
      cursor: result.list_complete === false ? result.cursor ?? null : null,
    };
  }

  async has(collection: string, id: string): Promise<boolean> {
    const value = await this.kv.get(this.key(collection, id), "text");
    return value !== null && value !== undefined;
  }

  async acquireLease(name: string, owner: string, expiresAt: number): Promise<boolean> {
    const current = await this.get<{ owner: string; expiresAt: number }>("leases", name);
    if (current && current.expiresAt > Date.now()) return false;
    await this.put("leases", name, { owner, expiresAt });
    return true;
  }

  async releaseLease(name: string, owner: string): Promise<void> {
    const current = await this.get<{ owner: string }>("leases", name);
    if (current?.owner === owner) await this.delete("leases", name);
  }
}
