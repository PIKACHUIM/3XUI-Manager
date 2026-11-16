import type { DocumentStore, ListOptions, Page } from "./store";

const keyPrefix = "3xu:record:";

export class KvStore implements DocumentStore {
  constructor(private readonly kv: Env["APP_KV"]) {}

  private key(collection: string, id: string): string {
    return `${keyPrefix}${encodeURIComponent(collection)}:${encodeURIComponent(id)}`;
  }

  async get<T>(collection: string, id: string): Promise<T | null> {
    return this.kv.get<T>(this.key(collection, id), "json");
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
    const values = await Promise.all(keys.map((item) => this.kv.get<unknown>(item.name, "json")));
    const items = values.filter((value): value is T => value !== null);
    return { items, cursor: result.list_complete ? null : result.cursor };
  }

  async has(collection: string, id: string): Promise<boolean> {
    return (await this.kv.get(this.key(collection, id), "text")) !== null;
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
