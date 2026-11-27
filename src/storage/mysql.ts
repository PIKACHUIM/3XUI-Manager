import type { RuntimeEnv } from "../env";
import type { KvLike } from "./kv";

interface MySqlPool {
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  end?(): Promise<void>;
}

interface MySqlModule {
  createPool(config: string | Record<string, unknown>): MySqlPool;
}

interface MySqlConfig {
  key: string;
  value: string | Record<string, unknown>;
}

function runtimeProcess(): { versions?: { node?: string } } | undefined {
  return (globalThis as { process?: { versions?: { node?: string } } }).process;
}

function mysqlConfig(env: RuntimeEnv): MySqlConfig | null {
  const url = env.MYSQL_URLS?.split(",").map((item) => item.trim()).find(Boolean);
  if (url) return { key: url, value: url };
  if (!env.MYSQL_HOST) return null;
  const value = {
    host: env.MYSQL_HOST,
    port: Number(env.MYSQL_PORT ?? 3306),
    user: env.MYSQL_USER ?? "",
    password: env.MYSQL_PASS ?? "",
    database: env.MYSQL_NAME ?? "",
    waitForConnections: true,
    connectionLimit: 5,
  };
  return { key: JSON.stringify(value), value };
}

let pool: MySqlPool | null = null;
let poolKey: string | null = null;
let schemaReady: Promise<void> | null = null;

/**
 * Remote MySQL document store.
 *
 * mysql2 opens a TCP connection and therefore only works on Node runtimes
 * (Vercel, a Node container, or an EdgeOne Node cloud function). Edge functions
 * should use Blob/KV instead.
 */
export class MySqlKv implements KvLike {
  constructor(private readonly env: RuntimeEnv) {}

  private async getPool(): Promise<MySqlPool> {
    if (!runtimeProcess()?.versions?.node) throw new Error("MySQL storage requires a Node.js runtime.");
    const config = mysqlConfig(this.env);
    if (!config) throw new Error("MySQL is not configured. Set MYSQL_URLS or MYSQL_HOST/MYSQL_NAME.");
    if (pool && poolKey === config.key) return pool;
    // Literal specifier so Vercel's file tracing includes mysql2. Cloudflare builds
    // alias this module to mysql-stub.ts through wrangler.jsonc.
    const module = await import("mysql2/promise") as MySqlModule;
    pool = module.createPool(config.value);
    poolKey = config.key;
    schemaReady = null;
    return pool;
  }

  private async ready(): Promise<MySqlPool> {
    const client = await this.getPool();
    if (!schemaReady) {
      schemaReady = (async () => {
        await client.query(`CREATE TABLE IF NOT EXISTS \`3xui_kv\` (
          \`k\` VARCHAR(512) NOT NULL PRIMARY KEY,
          \`v\` LONGTEXT NOT NULL,
          \`updated_at\` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`);
      })();
    }
    await schemaReady;
    return client;
  }

  async get(key: string, _type?: "text" | "json"): Promise<unknown> {
    const client = await this.ready();
    const [rows] = await client.query("SELECT `v` FROM `3xui_kv` WHERE `k` = ? LIMIT 1", [key]);
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const value = (rows[0] as { v?: unknown }).v;
    return typeof value === "string" ? value : null;
  }

  async put(key: string, value: string): Promise<void> {
    const client = await this.ready();
    await client.query(
      "INSERT INTO `3xui_kv` (`k`, `v`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `v` = VALUES(`v`)",
      [key, value],
    );
  }

  async delete(key: string): Promise<void> {
    const client = await this.ready();
    await client.query("DELETE FROM `3xui_kv` WHERE `k` = ?", [key]);
  }

  async list(options: { prefix: string; limit?: number; cursor?: string }): Promise<{
    keys: Array<{ name: string }>;
    list_complete?: boolean;
    cursor?: string;
  }> {
    const client = await this.ready();
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 100);
    const cursor = options.cursor ?? "";
    const [rows] = await client.query(
      "SELECT `k` FROM `3xui_kv` WHERE LEFT(`k`, ?) = ? AND `k` > ? ORDER BY `k` LIMIT ?",
      [options.prefix.length, options.prefix, cursor, limit + 1],
    );
    const values = Array.isArray(rows) ? rows : [];
    const complete = values.length <= limit;
    const page = values.slice(0, limit).flatMap((row) => {
      const key = (row as { k?: unknown }).k;
      return typeof key === "string" ? [{ name: key }] : [];
    });
    return {
      keys: page,
      list_complete: complete,
      cursor: complete ? undefined : page.at(-1)?.name,
    };
  }
}
