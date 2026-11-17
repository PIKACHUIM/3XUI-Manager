import { Hono } from "hono";
import type { Context, Next } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { RuntimeEnv } from "../env";
import { ensureDefaults, FREE_PLAN_ID, readSetting } from "../domain/defaults";
import { hashPassword, randomToken, sha256, verifyPassword, verifySecret } from "../domain/security";
import type { Invite, PasswordReset, Plan, Session, User } from "../domain/types";
import type { ApiEnv } from "./context";
import { validateSameOrigin } from "./context";
import { verifyTurnstile } from "../services/turnstile";
import { sendEmail } from "../services/email";
import { syncUserEntitlements } from "../services/xui-sync";
import { D1Store } from "../storage/d1";

const auth = new Hono<ApiEnv>();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const expiryAfter = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();

async function csrf(c: Context<ApiEnv>, next: Next) {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method) && !validateSameOrigin(c.req.raw)) {
    return c.json({ error: "Request origin is not allowed." }, 403);
  }
  await next();
}

auth.use("*", csrf);

auth.get("/config", async (c) => {
  const store = c.get("store");
  const [registrationTurnstileEnabled, checkinTurnstileEnabled] = await Promise.all([
    readSetting<boolean>(store, "turnstileEnabled", false),
    readSetting<boolean>(store, "turnstileOnCheckin", false),
  ]);
  return c.json({
    turnstileSiteKey: (await readSetting<string>(store, "turnstileSiteKey", "")).trim() || null,
    registrationTurnstileEnabled,
    checkinTurnstileEnabled,
  });
});

async function readJson(c: Context<ApiEnv>): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await c.req.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function patchUser(store: ApiEnv["Variables"]["store"], user: User, patch: Partial<User>): Promise<void> {
  if (store instanceof D1Store) {
    const updated = await store.patchUser(user.id, patch);
    if (updated) Object.assign(user, updated);
  } else {
    Object.assign(user, patch);
    await store.put("users", user.id, user);
  }
}

async function createSession(c: Context<ApiEnv>, user: User): Promise<void> {
  const raw = randomToken();
  const digest = await sha256(raw);
  const session: Session = { id: digest, userId: user.id, expiresAt: expiryAfter(7 * 24 * 60 * 60), createdAt: new Date().toISOString() };
  await c.get("store").put("sessions", digest, session);
  setCookie(c, "3xui_session", raw, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: "/",
    maxAge: 7 * 24 * 60 * 60,
  });
}

async function makeUser(store: ApiEnv["Variables"]["store"], env: RuntimeEnv, email: string, password: string, role: "admin" | "user", invitation?: Invite): Promise<User> {
  const now = new Date().toISOString();
  const balance = await readSetting<number>(store, "defaultBalanceMinor", 0);
  const freePlan = await store.get<Plan>("plans", FREE_PLAN_ID);
  const user: User = {
    id: crypto.randomUUID(), email: email.toLowerCase(), passwordHash: await hashPassword(password), emailVerifiedAt: null,
    role, balanceMinor: balance, planId: FREE_PLAN_ID, planLevel: 0,
    planExpiresAt: freePlan && freePlan.validityDays > 0 ? new Date(Date.now() + freePlan.validityDays * 86400000).toISOString() : null,
    planTrafficBytes: freePlan?.trafficBytes ?? 0,
    billedBytes: 0, planStartedAt: now, trafficResetAt: null, enabled: true,
    inviteCode: null, invitedBy: invitation?.createdBy ?? null, inviteCount: 0, checkinStreak: 0,
    lastCheckinAt: null, lastActiveAt: now, createdAt: now, updatedAt: now,
  };
  const userInvitesEnabled = await readSetting<boolean>(store, "userInvitesEnabled", false);
  if (userInvitesEnabled) user.inviteCode = randomToken(9);
  await store.put("users", user.id, user);
  await store.put("user-email", user.email, { userId: user.id });
  if (invitation) {
    invitation.usedBy = user.id;
    invitation.usedAt = now;
    await store.put("invites", invitation.code, invitation);
    if (invitation.createdBy) {
      const inviter = await store.get<User>("users", invitation.createdBy);
      if (inviter) {
        inviter.inviteCount += 1;
        inviter.updatedAt = now;
        await patchUser(store, inviter, { inviteCount: inviter.inviteCount, updatedAt: now });
      }
    }
  }
  if (role === "admin" && env.ADMIN_BOOTSTRAP_TOKEN) {
    console.log(JSON.stringify({ event: "bootstrap_admin_created", userId: user.id }));
  }
  await syncUserEntitlements(store, env, user.id).catch((error: unknown) => {
    console.error(JSON.stringify({ event: "account_sync_failed", userId: user.id, message: error instanceof Error ? error.message : "unknown" }));
  });
  return user;
}

auth.post("/register", async (c) => {
  const store = c.get("store");
  await ensureDefaults(store);
  const body = await readJson(c);
  if (!body) return c.json({ error: "Invalid request body." }, 400);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const inviteCode = typeof body.inviteCode === "string" ? body.inviteCode.trim() : "";
  if (!emailPattern.test(email) || email.length > 254) return c.json({ error: "Enter a valid email address." }, 422);
  if (password.length < 12 || password.length > 256) return c.json({ error: "Password must contain 12 to 256 characters." }, 422);
  const registrationEnabled = await readSetting<boolean>(store, "registrationEnabled", true);
  if (!registrationEnabled) return c.json({ error: "Registration is currently closed." }, 403);
  const turnstileEnabled = await readSetting<boolean>(store, "turnstileEnabled", false);
  if (turnstileEnabled && !(await verifyTurnstile(c.env, typeof body.turnstileToken === "string" ? body.turnstileToken : undefined, "signup", new URL(c.req.url).hostname, c.req.header("cf-connecting-ip")))) {
    return c.json({ error: "Human verification failed." }, 422);
  }
  if (await store.has("user-email", email)) return c.json({ error: "An account with this email already exists." }, 409);
  const inviteRequired = await readSetting<boolean>(store, "inviteRequired", false);
  let invitation: Invite | undefined;
  if (inviteCode) {
    const found = await store.get<Invite>("invites", inviteCode);
    if (!found || found.usedBy || (found.expiresAt && Date.parse(found.expiresAt) <= Date.now())) return c.json({ error: "This invitation code is invalid or already used." }, 422);
    invitation = found;
  } else if (inviteRequired) {
    return c.json({ error: "An invitation code is required." }, 422);
  }
  const user = await makeUser(store, c.env, email, password, "user", invitation);
  const verificationRequired = await readSetting<boolean>(store, "emailVerificationRequired", true);
  if (verificationRequired) {
    const raw = randomToken();
    const tokenHash = await sha256(raw);
    await store.put("email-verification", tokenHash, { userId: user.id, expiresAt: expiryAfter(60 * 60), createdAt: new Date().toISOString() });
    const base = await readSetting<string>(c.get("store"), "publicAppUrl", "") || new URL(c.req.url).origin;
    try {
      await sendEmail(c.env, email, "Verify your 3XUI Manager account", `<p>Verify your account: <a href="${base}/verify-email?token=${encodeURIComponent(raw)}">Continue</a></p>`);
    } catch (error) {
      console.error(JSON.stringify({ event: "verification_email_failed", userId: user.id, message: error instanceof Error ? error.message : "unknown" }));
      return c.json({ error: "Account created, but verification email could not be delivered. Contact the administrator." }, 503);
    }
    return c.json({ message: "Account created. Check your email to verify it." }, 201);
  }
  user.emailVerifiedAt = new Date().toISOString();
  user.updatedAt = user.emailVerifiedAt;
  await patchUser(store, user, { emailVerifiedAt: user.emailVerifiedAt, updatedAt: user.updatedAt });
  await createSession(c, user);
  return c.json({ user: publicUser(user) }, 201);
});

auth.post("/login", async (c) => {
  const store = c.get("store");
  const body = await readJson(c);
  if (!body) return c.json({ error: "Invalid request body." }, 400);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const index = await store.get<{ userId: string }>("user-email", email);
  const user = index ? await store.get<User>("users", index.userId) : null;
  if (!user || !user.enabled || !(await verifyPassword(password, user.passwordHash))) return c.json({ error: "Email or password is incorrect." }, 401);
  const verificationRequired = await readSetting<boolean>(store, "emailVerificationRequired", true);
  if (verificationRequired && !user.emailVerifiedAt) return c.json({ error: "Verify your email before signing in." }, 403);
  user.lastActiveAt = new Date().toISOString();
  user.updatedAt = user.lastActiveAt;
  await patchUser(store, user, { lastActiveAt: user.lastActiveAt, updatedAt: user.updatedAt });
  await createSession(c, user);
  return c.json({ user: publicUser(user) });
});

auth.post("/logout", async (c) => {
  const raw = getCookie(c, "3xui_session");
  if (raw) await c.get("store").delete("sessions", await sha256(raw));
  deleteCookie(c, "3xui_session", { path: "/" });
  return c.json({ ok: true });
});

auth.get("/me", async (c) => {
  const raw = getCookie(c, "3xui_session");
  if (!raw) return c.json({ user: null });
  const store = c.get("store");
  const digest = await sha256(raw);
  const session = await store.get<Session>("sessions", digest);
  if (!session || Date.parse(session.expiresAt) <= Date.now()) return c.json({ user: null });
  const user = await store.get<User>("users", session.userId);
  return c.json({ user: user?.enabled ? publicUser(user) : null });
});

auth.post("/verify-email", async (c) => {
  const body = await readJson(c);
  const token = typeof body?.token === "string" ? body.token : "";
  if (!token) return c.json({ error: "Verification token is required." }, 422);
  const store = c.get("store");
  const digest = await sha256(token);
  const verification = await store.get<{ userId: string; expiresAt: string }>("email-verification", digest);
  if (!verification || Date.parse(verification.expiresAt) <= Date.now()) return c.json({ error: "Verification link expired." }, 422);
  const user = await store.get<User>("users", verification.userId);
  if (!user) return c.json({ error: "Account not found." }, 404);
  user.emailVerifiedAt = new Date().toISOString();
  user.updatedAt = user.emailVerifiedAt;
  await patchUser(store, user, { emailVerifiedAt: user.emailVerifiedAt, updatedAt: user.updatedAt });
  await store.delete("email-verification", digest);
  await createSession(c, user);
  return c.json({ user: publicUser(user) });
});

auth.post("/forgot-password", async (c) => {
  const body = await readJson(c);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const index = await c.get("store").get<{ userId: string }>("user-email", email);
  if (index) {
    const token = randomToken();
    const digest = await sha256(token);
    const user = await c.get("store").get<User>("users", index.userId);
    if (user) {
      await c.get("store").put("password-resets", digest, { userId: user.id, expiresAt: expiryAfter(30 * 60), createdAt: new Date().toISOString() } satisfies PasswordReset);
      const base = await readSetting<string>(c.get("store"), "publicAppUrl", "") || new URL(c.req.url).origin;
      try { await sendEmail(c.env, user.email, "Reset your 3XUI Manager password", `<p>Reset your password: <a href="${base}/reset-password?token=${encodeURIComponent(token)}">Continue</a></p>`); }
      catch (error) { console.error(JSON.stringify({ event: "password_reset_email_failed", userId: user.id, message: error instanceof Error ? error.message : "unknown" })); }
    }
  }
  return c.json({ message: "If the account exists, a password reset link has been sent." });
});

auth.post("/reset-password", async (c) => {
  const body = await readJson(c);
  const token = typeof body?.token === "string" ? body.token : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (password.length < 12 || password.length > 256) return c.json({ error: "Password must contain 12 to 256 characters." }, 422);
  const digest = await sha256(token);
  const reset = await c.get("store").get<PasswordReset>("password-resets", digest);
  if (!reset || Date.parse(reset.expiresAt) <= Date.now()) return c.json({ error: "Reset link expired." }, 422);
  const user = await c.get("store").get<User>("users", reset.userId);
  if (!user) return c.json({ error: "Account not found." }, 404);
  user.passwordHash = await hashPassword(password);
  user.updatedAt = new Date().toISOString();
  await patchUser(c.get("store"), user, { passwordHash: user.passwordHash, updatedAt: user.updatedAt });
  await c.get("store").delete("password-resets", digest);
  const sessions = await c.get("store").list<Session>("sessions", { limit: 100 });
  await Promise.all(sessions.items.filter((item) => item.userId === user.id).map((item) => c.get("store").delete("sessions", item.id)));
  return c.json({ ok: true });
});

auth.post("/bootstrap", async (c) => {
  const supplied = c.req.header("x-admin-bootstrap-token") ?? "";
  if (!c.env.ADMIN_BOOTSTRAP_TOKEN || !(await verifySecret(supplied, c.env.ADMIN_BOOTSTRAP_TOKEN))) return c.json({ error: "Bootstrap token is invalid." }, 403);
  const store = c.get("store");
  const admins = await store.list<User>("users", { limit: 100, prefix: "" });
  if (admins.items.some((user) => user.role === "admin")) return c.json({ error: "An administrator already exists." }, 409);
  const body = await readJson(c);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!emailPattern.test(email) || password.length < 12 || password.length > 256) return c.json({ error: "Provide a valid email and a password of at least 12 characters." }, 422);
  if (await store.has("user-email", email)) return c.json({ error: "An account with this email already exists." }, 409);
  const admin = await makeUser(store, c.env, email, password, "admin");
  admin.emailVerifiedAt = new Date().toISOString();
  await store.put("users", admin.id, admin);
  await createSession(c, admin);
  return c.json({ user: publicUser(admin) }, 201);
});

auth.post("/invites", async (c) => {
  const raw = getCookie(c, "3xui_session");
  const digest = raw ? await sha256(raw) : "";
  const session = raw ? await c.get("store").get<Session>("sessions", digest) : null;
  const user = session ? await c.get("store").get<User>("users", session.userId) : null;
  if (!user?.enabled) return c.json({ error: "Authentication required." }, 401);
  const enabled = await readSetting<boolean>(c.get("store"), "userInvitesEnabled", false);
  const limit = await readSetting<number>(c.get("store"), "userInviteLimit", 0);
  if (user.role !== "admin" && (!enabled || user.inviteCount >= limit)) return c.json({ error: "Invitation generation is not enabled for this account." }, 403);
  const code = randomToken(9);
  const invite: Invite = { code, createdBy: user.id, usedBy: null, usedAt: null, expiresAt: null, createdAt: new Date().toISOString() };
  await c.get("store").put("invites", code, invite);
  return c.json({ invite }, 201);
});

function publicUser(user: User): Omit<User, "passwordHash"> {
  const { passwordHash: _passwordHash, ...safe } = user;
  return safe;
}

export default auth;
