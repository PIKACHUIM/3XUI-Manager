import { afterEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../../domain/security";
import type { NodeRecord } from "../../domain/types";
import { probeNode, ThreeXuiClient } from "./client";

const ENCRYPTION_KEY = "unit-test-encryption-key-0123456789";
const env = { APP_ENCRYPTION_KEY: ENCRYPTION_KEY } as never;

async function makeNode(overrides: Partial<NodeRecord> = {}): Promise<NodeRecord> {
  return {
    id: "node-1", name: "Tokyo Edge", region: "JP", panelUrl: "https://panel.example.test:2053",
    publicAddress: "", username: "pika", encryptedPassword: await encryptSecret("secret", ENCRYPTION_KEY),
    apiTokenEncrypted: null, basePath: "/", status: "unknown", supportedApi: null, lastCheckedAt: null,
    inboundCount: 0, syncStatus: "pending", lastSyncAt: null, lastError: null, enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

type Call = { url: string; method: string; body: string | null; cookie: string | null; csrf: string | null; contentType: string | null; };

function capture(input: RequestInfo | URL, init: RequestInit | undefined, calls: Call[]): Call {
  const headers = new Headers(init?.headers);
  const call: Call = {
    url: String(input),
    method: (init?.method ?? "GET").toUpperCase(),
    body: typeof init?.body === "string" ? init.body : null,
    cookie: headers.get("cookie"),
    csrf: headers.get("x-csrf-token"),
    contentType: headers.get("content-type"),
  };
  calls.push(call);
  return call;
}

function json(body: unknown, init: { status?: number; cookie?: string } = {}): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  if (init.cookie) headers.set("set-cookie", init.cookie);
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

function empty(status: number): Response {
  return new Response(null, { status });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ThreeXuiClient login", () => {
  it("fetches a CSRF token bound to the session before posting the login form", async () => {
    const calls: Call[] = [];
    let csrfCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = capture(input, init, calls);
      if (call.url.endsWith("/csrf-token")) {
        csrfCalls += 1;
        return csrfCalls === 1
          ? json({ success: true, obj: "csrf-before" }, { cookie: "3x-ui=session-before; Path=/; HttpOnly" })
          : json({ success: true, obj: "csrf-after" }, { cookie: "3x-ui=session-after; Path=/; HttpOnly" });
      }
      if (call.url.endsWith("/login")) return json({ success: true, msg: "Login Successfully" }, { cookie: "3x-ui=session-after; Path=/; HttpOnly" });
      return json({ success: true, obj: [] });
    }));

    const client = await ThreeXuiClient.connect(env, await makeNode());
    await expect(client.listInbounds()).resolves.toEqual([]);

    const login = calls.find((call) => call.url.endsWith("/login"))!;
    expect(login.method).toBe("POST");
    expect(login.contentType).toBe("application/x-www-form-urlencoded");
    expect(login.body).toBe("username=pika&password=secret");
    expect(login.cookie).toBe("3x-ui=session-before");
    expect(login.csrf).toBe("csrf-before");

    const list = calls.at(-1)!;
    expect(list.url).toBe("https://panel.example.test:2053/panel/api/inbounds/list");
    expect(list.cookie).toBe("3x-ui=session-after");
    expect(list.csrf).toBe("csrf-after");
  });

  it("refreshes the CSRF token once when the panel answers 403", async () => {
    const calls: Call[] = [];
    let logins = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = capture(input, init, calls);
      if (call.url.endsWith("/csrf-token")) return json({ success: true, obj: `csrf-${calls.length}` }, { cookie: "3x-ui=s; Path=/" });
      if (call.url.endsWith("/login")) {
        logins += 1;
        return logins === 1 ? empty(403) : json({ success: true }, { cookie: "3x-ui=s; Path=/" });
      }
      return json({ success: true, obj: [] });
    }));

    const client = await ThreeXuiClient.connect(env, await makeNode());
    await expect(client.listInbounds()).resolves.toEqual([]);

    const loginCalls = calls.filter((call) => call.url.endsWith("/login"));
    expect(loginCalls).toHaveLength(2);
    expect(loginCalls[0].csrf).toBe("csrf-1");
    expect(loginCalls[1].csrf).not.toBe("csrf-1");
  });

  it("still logs in on panels without a CSRF endpoint", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = capture(input, init, calls);
      if (call.url.endsWith("/csrf-token")) return empty(404);
      if (call.url.endsWith("/login")) return json({ success: true }, { cookie: "3x-ui=legacy; Path=/" });
      return json({ success: true, obj: [] });
    }));

    const client = await ThreeXuiClient.connect(env, await makeNode());
    await expect(client.listInbounds()).resolves.toEqual([]);

    const login = calls.find((call) => call.url.endsWith("/login"))!;
    expect(login.contentType).toBe("application/x-www-form-urlencoded");
    expect(login.csrf).toBeNull();
    expect(calls.at(-1)?.cookie).toBe("3x-ui=legacy");
  });

  it("falls back to a JSON login body when the panel rejects the form encoding", async () => {
    const calls: Call[] = [];
    let logins = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = capture(input, init, calls);
      if (call.url.endsWith("/csrf-token")) return empty(404);
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
  });

  it("surfaces the panel error message when the credentials are rejected", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = capture(input, init, []);
      if (call.url.endsWith("/csrf-token")) return json({ success: true, obj: "csrf" }, { cookie: "3x-ui=s; Path=/" });
      return json({ success: false, msg: "Invalid username or password or two-factor code." }, { status: 401 });
    }));

    await expect(ThreeXuiClient.connect(env, await makeNode())).rejects.toThrow(/Invalid username or password/);
  });

  it("describes a non-JSON rejection with its status and content type", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = capture(input, init, []);
      if (call.url.endsWith("/csrf-token")) return empty(404);
      return new Response("<html>forbidden</html>", { status: 403, headers: { "content-type": "text/html" } });
    }));

    await expect(ThreeXuiClient.connect(env, await makeNode())).rejects.toThrow(/HTTP 403, text\/html/);
  });

  it("explains when the address is a dashboard instead of a panel", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = capture(input, init, []);
      if (call.url.endsWith("/csrf-token")) return new Response("<!doctype html><html><body>dashboard</body></html>", { status: 200, headers: { "content-type": "text/html" } });
      return new Response(null, { status: 405 });
    }));

    await expect(ThreeXuiClient.connect(env, await makeNode())).rejects.toThrow(/not the 3X-UI API/);
  });

  it("explains that Cloudflare cannot fetch a bare IP address", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capture(input, init, []);
      return new Response("error code: 1003\n", { status: 403, headers: { "content-type": "text/plain; charset=UTF-8" } });
    }));

    await expect(ThreeXuiClient.connect(env, await makeNode())).rejects.toThrow(/cannot fetch a bare IP address/);
  });

  it("routes an IPv4 panel through nip.io because Workers cannot fetch an IP", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = capture(input, init, calls);
      if (call.url.endsWith("/csrf-token")) return json({ success: true, obj: "csrf" }, { cookie: "3x-ui=s; Path=/" });
      if (call.url.endsWith("/login")) return json({ success: true }, { cookie: "3x-ui=s; Path=/" });
      return json({ success: true, obj: [] });
    }));

    const client = await ThreeXuiClient.connect(env, await makeNode({ panelUrl: "http://43.226.62.230:61090" }));
    await expect(client.listInbounds()).resolves.toEqual([]);

    expect(calls.every((call) => new URL(call.url).hostname === "43.226.62.230.nip.io")).toBe(true);
    expect(calls.at(-1)?.url).toBe("http://43.226.62.230.nip.io:61090/panel/api/inbounds/list");
  });

  it("names the contacted host when the panel never answers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }));

    await expect(ThreeXuiClient.connect(env, await makeNode({ panelUrl: "http://43.226.62.230:61090" })))
      .rejects.toThrow(/no response from 43\.226\.62\.230\.nip\.io:61090 within 12s/);
  });

  it("asks for HTTPS when Cloudflare gets an empty plain HTTP reply", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capture(input, init, []);
      return new Response("error code: 520\n", { status: 520, headers: { "content-type": "text/plain; charset=UTF-8" } });
    }));

    await expect(ThreeXuiClient.connect(env, await makeNode())).rejects.toThrow(/serve the panel over HTTPS/);
  });

  it("points at the firewall when Cloudflare cannot open a connection", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capture(input, init, []);
      return new Response("error code: 521\n", { status: 521, headers: { "content-type": "text/plain; charset=UTF-8" } });
    }));

    await expect(ThreeXuiClient.connect(env, await makeNode())).rejects.toThrow(/check its firewall/);
  });

  it("keeps the password as a fallback when the API token is rejected", async () => {
    const calls: Call[] = [];
    let csrfCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = capture(input, init, calls);
      if (call.url.endsWith("/csrf-token")) {
        csrfCalls += 1;
        return json({ success: true, obj: `csrf-${csrfCalls}` }, { cookie: `3x-ui=session-${csrfCalls}; Path=/` });
      }
      if (call.url.endsWith("/login")) return json({ success: true }, { cookie: "3x-ui=logged-in; Path=/" });
      if (call.cookie === null) return json({ success: false, msg: "please login first" }, { status: 401 });
      return json({ success: true, obj: [] });
    }));

    const node = await makeNode({ apiTokenEncrypted: await encryptSecret("stale-token", ENCRYPTION_KEY) });
    const client = await ThreeXuiClient.connect(env, node);
    await expect(client.listInbounds()).resolves.toEqual([]);

    expect(calls[0].url).toBe("https://panel.example.test:2053/panel/api/inbounds/list");
    expect(calls[0].cookie).toBeNull();
    expect(calls.some((call) => call.url.endsWith("/login"))).toBe(true);
    expect(calls.at(-1)?.cookie).toBe("3x-ui=session-2");
    expect(calls.at(-1)?.csrf).toBe("csrf-2");
  });
});

describe("probeNode", () => {
  it("reports the panel message instead of a generic failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = capture(input, init, []);
      if (call.url.endsWith("/csrf-token")) return json({ success: true, obj: "csrf" }, { cookie: "3x-ui=s; Path=/" });
      return json({ success: false, msg: "two-factor authentication code required" }, { status: 401 });
    }));

    const probe = await probeNode(env, await makeNode());
    expect(probe.status).toBe("offline");
    expect(probe.error).toContain("two-factor authentication code required");
  });
});

describe("upsertClient", () => {
  it("sends the plan quota in bytes because 3X-UI stores totalGB as bytes", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = capture(input, init, calls);
      if (call.url.endsWith("/csrf-token")) return json({ success: true, obj: "csrf" }, { cookie: "3x-ui=s; Path=/" });
      if (call.url.endsWith("/login")) return json({ success: true }, { cookie: "3x-ui=s; Path=/" });
      return json({ success: true, obj: {} });
    }));

    const client = await ThreeXuiClient.connect(env, await makeNode());
    await client.upsertClient(
      {
        id: "map-1", userId: "user-1", inboundId: "in-1", email: "u_user-1_in-1", clientId: "11111111-1111-4111-8111-111111111111",
        encryptedSecret: null, flow: "", enable: true, syncStatus: "pending", syncError: null, syncedNodes: [],
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "in-1", name: "Tokyo", protocol: "vless", network: "ws", port: 443, minimumLevel: 0, multiplier: 1, enabled: true,
        config: {}, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      },
      { id: "in-1:node-1", inboundId: "in-1", nodeId: "node-1", panelInboundId: 7, createdAt: "2026-01-01T00:00:00.000Z" },
      {
        id: "user-1", email: "u@example.test", passwordHash: "", emailVerifiedAt: null, role: "user", balanceMinor: 0,
        planId: "plan-1", planLevel: 1, planExpiresAt: null, planTrafficBytes: 102_400_000_000_000, billedBytes: 0,
        planStartedAt: "2026-01-01T00:00:00.000Z", trafficResetAt: null, enabled: true, inviteCode: null, invitedBy: null,
        inviteCount: 0, checkinStreak: 0, lastCheckinAt: null, lastActiveAt: null,
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      },
    );

    const add = calls.find((call) => call.url.endsWith("/panel/api/clients/add"))!;
    expect(JSON.parse(add.body!)).toMatchObject({
      client: { email: "u_user-1_in-1", totalGB: 102_400_000_000_000, enable: true },
      inboundIds: [7],
    });
  });
});
