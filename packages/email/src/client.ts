import { emailEnv } from "./env.js";

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export type SendEmailInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
  // Optional override for the `From:` header. Defaults to `RESEND_FROM`.
  from?: string;
  // Forwarded as Resend's `Idempotency-Key` header. A repeated send with the
  // same key returns the original response instead of dispatching twice.
  idempotencyKey?: string;
};

export type SendEmailResult =
  | { ok: true; messageId: string | null }
  | { ok: false; error: string; status: number | null };

// Minimal fetch-based Resend adapter. We deliberately avoid the `resend` SDK
// so this package can run on any Node 20+ runtime (web RSC, Trigger.dev) with
// no extra dependencies. The HTTP surface we use is stable:
//   POST https://api.resend.com/emails
//   Authorization: Bearer <RESEND_API_KEY>
//   Idempotency-Key: <stable token>          (optional)
//   Content-Type: application/json
//   { from, to, subject, html, text }
//
// The function never throws — it returns a typed result so callers can log
// the failure and continue (lesson processing must not roll back on a Resend
// hiccup; see VOL-125 acceptance criteria).
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  let apiKey: string;
  try {
    apiKey = emailEnv.resendApiKey();
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      status: null,
    };
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (input.idempotencyKey) {
    headers["Idempotency-Key"] = input.idempotencyKey;
  }

  const body = JSON.stringify({
    from: input.from ?? emailEnv.resendFrom(),
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
  });

  let response: Response;
  try {
    response = await fetch(RESEND_ENDPOINT, { method: "POST", headers, body });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      status: null,
    };
  }

  if (!response.ok) {
    const text = await safeReadText(response);
    return {
      ok: false,
      error: text || `Resend returned HTTP ${response.status}`,
      status: response.status,
    };
  }

  const parsed = (await safeReadJson(response)) as { id?: string } | null;
  return { ok: true, messageId: parsed?.id ?? null };
}

async function safeReadText(response: Response): Promise<string | null> {
  try {
    return await response.text();
  } catch {
    return null;
  }
}

async function safeReadJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
