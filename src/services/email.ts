import type { RuntimeEnv } from "../env";
import { readBusinessConfig } from "./settings";

export async function sendEmail(env: RuntimeEnv, to: string, subject: string, html: string): Promise<void> {
  const config = await readBusinessConfig(env, ["RESEND_API_KEY", "RESEND_FROM"]);
  if (!config.RESEND_API_KEY || !config.RESEND_FROM) throw new Error("Email delivery is not configured. Set resendApiKey and resendFrom in system settings.");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: config.RESEND_FROM, to: [to], subject, html }),
  });
  if (!response.ok) {
    const message = await response.text();
    console.error(JSON.stringify({ event: "resend_rejected", status: response.status, detail: message.slice(0, 300) }));
    throw new Error("Email provider rejected the message.");
  }
}
