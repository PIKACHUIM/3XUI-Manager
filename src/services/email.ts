import type { RuntimeEnv } from "../env";

export async function sendEmail(env: RuntimeEnv, to: string, subject: string, html: string): Promise<void> {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) throw new Error("Email delivery is not configured. Set RESEND_API_KEY and RESEND_FROM.");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.RESEND_FROM, to: [to], subject, html }),
  });
  if (!response.ok) {
    const message = await response.text();
    console.error(JSON.stringify({ event: "resend_rejected", status: response.status, detail: message.slice(0, 300) }));
    throw new Error("Email provider rejected the message.");
  }
}
