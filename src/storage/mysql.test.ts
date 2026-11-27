import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../env";

const fake = vi.hoisted(() => {
  const data = new Map<string, string>();
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith("CREATE TABLE")) return [[], []];
    if (sql.startsWith("SELECT `v`")) return [[{ v: data.get(String(params[0])) }], []];
    if (sql.startsWith("SELECT `k`")) {
      const prefix = String(params[1]);
      const cursor = String(params[2] ?? "");
      const limit = Number(params[3] ?? 101);
      const keys = [...data.keys()].filter((key) => key.startsWith(prefix) && key > cursor).sort();
      return [keys.slice(0, limit).map((k) => ({ k })), []];
    }
    if (sql.startsWith("INSERT")) {
      data.set(String(params[0]), String(params[1]));
      return [{ affectedRows: 1 }, []];
    }
    if (sql.startsWith("DELETE")) {
      data.delete(String(params[0]));
      return [{ affectedRows: 1 }, []];
    }
    return [[], []];
  });
  return { data, query };
});

vi.mock("mysql2/promise", () => ({ createPool: () => ({ query: fake.query }) }));

const { MySqlKv } = await import("./mysql");

describe("MySqlKv", () => {
  it("uses the MySQL kv table for document reads, writes and prefix listing", async () => {
    const store = new MySqlKv({ MYSQL_URLS: "mysql://user:pass@localhost:3306/manager" } as RuntimeEnv);
    await store.put("3xu:record:nodes:n1", JSON.stringify({ id: "n1" }));
    await store.put("3xu:record:nodes:n2", JSON.stringify({ id: "n2" }));

    expect(await store.get("3xu:record:nodes:n1")).toBe('{"id":"n1"}');
    expect((await store.list({ prefix: "3xu:record:nodes:", limit: 1 })).keys).toEqual([{ name: "3xu:record:nodes:n1" }]);
    await store.delete("3xu:record:nodes:n1");
    expect(await store.get("3xu:record:nodes:n1")).toBeNull();
    expect(fake.query).toHaveBeenCalledWith(expect.stringContaining("CREATE TABLE IF NOT EXISTS"));
  });
});
