import type { RuntimeEnv } from "../env";

export async function verifyTurnstile(env: RuntimeEnv, token: string | undefined, expectedAction: string, expectedHostname: string, remoteIp?: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY || !token || token.length > 2048 || !expectedAction || !expectedHostname) return false;
  const form = new FormData();
  form.set("secret", env.TURNSTILE_SECRET_KEY);
  form.set("response", token);
  if (remoteIp) form.set("remoteip", remoteIp);
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return false;
    const payload = await response.json() as { success?: boolean; action?: string; hostname?: string };
    return payload.success === true && payload.action === expectedAction && payload.hostname === expectedHostname;
  } catch {
    return false;
  }
}
