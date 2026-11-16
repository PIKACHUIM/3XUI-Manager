import { Hono } from "hono";
import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import type { RuntimeEnv } from "../env";
import type { DocumentStore } from "../storage/store";
import { getStore } from "../storage";
import { SESSION_COOKIE } from "../domain/defaults";
import { sha256 } from "../domain/security";
import type { Session, User } from "../domain/types";

export type ApiEnv = {
  Bindings: RuntimeEnv;
  Variables: { store: DocumentStore; user: User };
};

export const api = new Hono<ApiEnv>();

api.use("/api/*", async (c, next) => {
  c.set("store", getStore(c.env));
  await next();
});

export async function requireUser(c: Context<ApiEnv>, next: Next): Promise<void | Response> {
  const raw = getCookie(c, SESSION_COOKIE);
  if (!raw) return c.json({ error: "Authentication required." }, 401);
  const store = c.get("store");
  const hash = await sha256(raw);
  const session = await store.get<Session>("sessions", hash);
  if (!session || Date.parse(session.expiresAt) <= Date.now()) {
    if (session) await store.delete("sessions", hash);
    return c.json({ error: "Session expired." }, 401);
  }
  const user = await store.get<User>("users", session.userId);
  if (!user || !user.enabled) return c.json({ error: "Account is unavailable." }, 401);
  c.set("user", user);
  await next();
}

export async function requireAdmin(c: Context<ApiEnv>, next: Next): Promise<void | Response> {
  let denied = false;
  const result = await requireUser(c, async () => {
    if (c.get("user").role !== "admin") {
      denied = true;
      return;
    }
    await next();
  });
  if (result) return result;
  if (denied) return c.json({ error: "Administrator access required." }, 403);
}

export function validateSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export function jsonError(message: string, status: 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 = 400): Response {
  return Response.json({ error: message }, { status });
}
