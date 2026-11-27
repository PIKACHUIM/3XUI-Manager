import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import auth from "./api/auth";
import admin from "./api/admin";
import userApi from "./api/user";
import subscriptions from "./api/subscriptions";
import { payments, webhooks } from "./api/payments";
import { api, type ApiEnv } from "./api/context";
import { D1Store } from "./storage/d1";
import { runScheduledJobs } from "./worker/jobs";

api.route("/api/auth", auth);
api.route("/api/admin", admin);
api.route("/api/user", userApi);
api.route("/api/subscriptions", subscriptions);
api.route("/api/payments", payments);
api.route("/api/webhooks", webhooks);
api.get("/api/health", (c) => {
  const d1Available = c.get("store") instanceof D1Store;
  return c.json({
    status: "ok",
    service: "3xui-manager",
    time: new Date().toISOString(),
    storage: d1Available ? "d1" : "document",
    capabilities: { trafficMetering: d1Available, quotaEnforcement: d1Available, atomicPaymentSettlement: d1Available },
  });
});
api.get("/api", (c) => c.json({ name: "3XUI Manager API", version: "0.1.0" }));

/** Runs the same Cron jobs from Vercel Cron, EdgeOne/ESA external cron, or a Node scheduler. */
async function cron(c: Context<ApiEnv>) {
  const secret = c.env.CRON_SECRET;
  if (!secret) return c.json({ error: "CRON_SECRET is not configured." }, 503);
  const authorized = c.req.header("authorization") === `Bearer ${secret}` || c.req.header("x-cron-secret") === secret;
  if (!authorized) return c.json({ error: "Forbidden." }, 403);
  return c.json(await runScheduledJobs(c.env));
}
api.get("/api/cron", cron);
api.post("/api/cron", cron);

const app = new Hono<ApiEnv>();
app.use("/api/*", cors({
  origin: (origin, c) => origin === new URL(c.req.url).origin ? origin : "",
  allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  allowHeaders: ["Content-Type", "X-Admin-Bootstrap-Token"],
  credentials: true,
}));
app.route("/", api);
app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((error, c) => {
  const path = new URL(c.req.url).pathname;
  const subscriptionRequest = path.startsWith("/api/subscriptions/");
  console.error(JSON.stringify({ event: "worker_error", message: subscriptionRequest ? "Subscription request failed" : error.message, path: subscriptionRequest ? "/api/subscriptions/[redacted]" : path }));
  return c.json({ error: "Internal server error" }, 500);
});

export default app;
