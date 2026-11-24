import { Hono } from "hono";
import type { ApiEnv } from "./context";
import { renderSubscriptionFeed, subscriptionFeed, subscriptionIsActive } from "../services/subscriptions";

const subscriptions = new Hono<ApiEnv>();
const requestWindows = new Map<string, { startedAt: number; count: number }>();
const IP_WINDOW_MS = 60_000;
const IP_MAX_REQUESTS = 120;
const TOKEN_MAX_REQUESTS = 30;
const MAX_WINDOW_KEYS = 20_000;
/** Clients may keep the body, but every reuse has to revalidate so a plan or node change lands at once. */
const RESPONSE_CACHE_CONTROL = "private, max-age=0, must-revalidate";

/** A short fingerprint of the rendered feed, so an unchanged profile costs a 304 instead of a download. */
async function contentTag(format: string, body: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${format}\n${body}`));
  const bytes = new Uint8Array(digest);
  let tag = "";
  for (let index = 0; index < 10; index += 1) tag += bytes[index].toString(16).padStart(2, "0");
  return `"${tag}"`;
}

/** If-None-Match uses the weak comparison rule, so a client's W/ prefix still matches a strong tag. */
function matchesTag(header: string | undefined, tag: string): boolean {
  if (!header) return false;
  return header.split(",").some((value) => {
    const candidate = value.trim();
    return candidate === "*" || candidate === tag || candidate === `W/${tag}`;
  });
}

function allowRequest(key: string, limit: number, now: number): boolean {
  const current = requestWindows.get(key);
  if (!current || now - current.startedAt >= IP_WINDOW_MS) {
    requestWindows.set(key, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

function pruneRequestWindows(now: number): void {
  if (requestWindows.size < MAX_WINDOW_KEYS) return;
  for (const [key, value] of requestWindows) {
    if (now - value.startedAt >= IP_WINDOW_MS) requestWindows.delete(key);
  }
  while (requestWindows.size >= MAX_WINDOW_KEYS) {
    const oldest = requestWindows.keys().next();
    if (oldest.done) break;
    requestWindows.delete(oldest.value);
  }
}
subscriptions.use("*", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  await next();
});
subscriptions.get("/:token", async (c) => {
  const now = Date.now();
  pruneRequestWindows(now);
  const clientAddress = c.req.header("cf-connecting-ip") ?? "unknown";
  if (!allowRequest(`ip:${clientAddress}`, IP_MAX_REQUESTS, now)) {
    c.header("Retry-After", "60");
    return c.json({ error: "Too many subscription requests. Retry in one minute." }, 429);
  }
  const token = c.req.param("token");
  const format = c.req.query("format");
  if (format !== "clash" && format !== "v2ray" && format !== "shadowsocks") return c.json({ error: "Supported formats: clash, v2ray, shadowsocks (SIP008)." }, 400);
  try {
    const store = c.get("store");
    const feed = await subscriptionFeed(store, token);
    if (!feed) return c.json({ error: "Subscription not found." }, 404);
    if (!allowRequest(`token:${feed.user.id}`, TOKEN_MAX_REQUESTS, now)) {
      c.header("Retry-After", "60");
      return c.json({ error: "Too many subscription requests. Retry in one minute." }, 429);
    }
    if (!subscriptionIsActive(feed.user, feed.plan)) return c.json({ error: "Subscription is inactive or traffic quota is exhausted." }, 403);
    if (!c.env.APP_ENCRYPTION_KEY) return c.json({ error: "Subscription service is unavailable." }, 503);
    const result = await renderSubscriptionFeed(feed.user, feed.sources, c.env.APP_ENCRYPTION_KEY, format);
    if (!result.count) return c.json({ error: format === "shadowsocks" ? "No compatible Shadowsocks nodes with verified credentials are available. This format only supports Shadowsocks (SIP008)." : "No compatible, successfully synchronized nodes are available." }, 422);
    const tag = await contentTag(format, result.body);
    c.header("Cache-Control", RESPONSE_CACHE_CONTROL);
    c.header("ETag", tag);
    c.header("X-Subscription-Skipped", String(result.skipped));
    c.header("Subscription-Userinfo", `upload=0; download=${feed.user.billedBytes}; total=${feed.user.planTrafficBytes}${feed.user.planExpiresAt ? `; expire=${Math.floor(Date.parse(feed.user.planExpiresAt) / 1000)}` : ""}`);
    // A 304 keeps the headers above, so the client still refreshes its quota while reusing the profile.
    if (matchesTag(c.req.header("if-none-match"), tag)) return c.body(null, 304);
    c.header("Content-Type", result.contentType);
    return c.body(result.body);
  } catch {
    // Do not let global error logging record the bearer token embedded in this path.
    return c.json({ error: "Subscription service is unavailable." }, 503);
  }
});
export default subscriptions;
