import { Hono } from "hono";
import { cors } from "hono/cors";
import auth from "../api/auth";
import admin from "../api/admin";
import userApi from "../api/user";
import subscriptions from "../api/subscriptions";
import { payments, webhooks } from "../api/payments";
import { api, type ApiEnv } from "../api/context";
import { D1Store } from "../storage/d1";
import type { RuntimeEnv } from "../env";
import { runLifecycleMaintenance } from "../services/lifecycle";
import { runTrafficCollection } from "../services/traffic";

api.route("/api/auth", auth);
api.route("/api/admin", admin);
api.route("/api/user", userApi);
api.route("/api/subscriptions", subscriptions);
api.route("/api/payments", payments);
api.route("/api/webhooks", webhooks);
api.get("/api/health", (c) => {
  const d1Available = c.get("store") instanceof D1Store;
  return c.json({ status: "ok", service: "3xui-manager", time: new Date().toISOString(), capabilities: { trafficMetering: d1Available, quotaEnforcement: d1Available, atomicPaymentSettlement: d1Available } });
});
api.get("/api", (c) => c.json({ name: "3XUI Manager API", version: "0.1.0" }));

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

export default {
  fetch: app.fetch,
  scheduled(_controller: ScheduledController, env: RuntimeEnv, context: ExecutionContext) {
    context.waitUntil(Promise.all([runTrafficCollection(env), runLifecycleMaintenance(env)]).catch((error: unknown) => {
      console.error(JSON.stringify({ event: "scheduled_jobs_failed", message: error instanceof Error ? error.message : "unknown" }));
    }));
  },
};
