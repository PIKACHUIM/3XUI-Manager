import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../../domain/security";
import type { NodeRecord } from "../../domain/types";
import { probeNode, ThreeXuiClient } from "./client";

const ENCRYPTION_KEY = "unit-test-encryption-key-0123456789";
const env = { APP_ENCRYPTION_KEY: ENCRYPTION_KEY } as never;

async function makeNode(overrides: Partial<NodeRecord> = {}): Promise<NodeRecord> {
  return {
    id: "node-1", name: "Tokyo Edge", region: "JP", panelUrl: "https://panel.example.test:2053",
    publicAddress: "", username: "admin", encryptedPassword: await encryptSecret("secret", ENCRYPTION_KEY),
    apiTokenEncrypted: null, basePath: "/", status: "unknown", supportedApi: null, lastCheckedAt: null,
    inboundCount: 0, syncStatus: "pending", lastSyncAt: null, lastError: null, enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

type Call = { url: string; body: string | null; cookie: string | null; contentType: string | null };

function record(input: RequestInfo | URL, init?: RequestInit, calls: Call[] = []): Call {
  const headers = new Headers(init?.headers);
  const call = {
    url: String(input),
    body: typeof init?.body === "string" ? init.body : null,
    cookie: headers.get("cookie"),
    contentType: headers.get("content-type"),
  };
  calls.push(call);
  return call;
}

function json(body: unknown, init: { status?: number; cookie?: string } = {}): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (init.cookie) headers.set("set-cookie", init.cookie);
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ThreeXuiClient login", () => {
  it("posts the form encoding first and replays the session cookie", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = record(input, init, calls);
      if (call.url.endsWith("/login")) return json({ success: true, msg: "Login Successfully" }, { cookie: "3x-ui=abc123; Path=/; HttpOnly" });
      return json({ success: true, obj: [] });
    }));

    const client = await ThreeXuiClient.connect(env, await makeNode());
    await expect(client.listInbounds()).resolves.toEqual([]);

    expect(calls[0].url).toBe("https://panel.example.test:2053/login");
    expect(calls[0].contentType).toBe("application/x-www-form-urlencoded");
    expect(calls[0].body).toBe("username=admin&password=secret");
    expect(calls[1].cookie).toBe("3x-ui=abc123");
  });

  it("falls back to a JSON login body when the panel rejects the form encoding", async () => {
    const calls: Call[] = [];
    let logins = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = record(input, init, calls);
      if (call.url.endsWith("/login")) {
        logins += 1;
        if (logins === 1) return json({ success: false, msg: "username or password is empty" });
        return json({ success: true }, { cookie: "3x-ui=json-ok; Path=/" });
      }
      return json({ success: true, obj: [] });
    }));

    const client = await ThreeXuiClient.connect(env, await makeNode());
    await expect(client.listInbounds()).resolves.toEqual([]);

    const loginCalls = calls.filter((call) => call.url.endsWith("/login"));
    expect(loginCalls).toHaveLength(2);
    expect(loginCalls[0].contentType).toBe("application/x-www-form-urlencoded");
    expect(loginCalls[1].contentType).toBe("application/json");
    expect(calls.at(-1)?.cookie).toBe("3x-ui=json-ok");
  });

  it("surfaces the panel error message when the credentials are rejected", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      record(input, init);
      return json({ success: false, msg: "用户名或密码错误" }, { status: 401 });
    }));

    await expect(ThreeXuiClient.connect(env, await makeNode())).rejects.toThrow(/用户名或密码错误/);
  });

  it("keeps the password as a fallback when the API token is rejected", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = record(input, init, calls);
      if (call.url.endsWith("/login")) return json({ success: true }, { cookie: "3x-ui=session; Path=/" });
      if (call.cookie === null) return json({ success: false, msg: "please login first" }, { status: 401 });
      return json({ success: true, obj: [] });
    }));

    const node = await makeNode({ apiTokenEncrypted: await encryptSecret("stale-token", ENCRYPTION_KEY) });
    const client = await ThreeXuiClient.connect(env, node);
    await expect(client.listInbounds()).resolves.toEqual([]);

    expect(calls[0].url).toBe("https://panel.example.test:2053/panel/api/inbounds/list");
    expect(calls[0].cookie).toBeNull();
    expect(calls[1].url).toBe("https://panel.example.test:2053/login");
    expect(calls[2].cookie).toBe("3x-ui=session");
  });
});

describe("probeNode", () => {
  it("reports the panel message instead of a generic failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      record(input, init);
      return json({ success: false, msg: "two-factor authentication code required" }, { status: 401 });
    }));

    const probe = await probeNode(env, await makeNode());
    expect(probe.status).toBe("offline");
    expect(probe.error).toContain("two-factor authentication code required");
  });
});
