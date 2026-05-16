import { sendEmail, type SendEmailResult } from "./client.js";
import {
  renderLessonFailedEmail,
  renderLessonReadyEmail,
  type LessonCounts,
  type LessonFailedTemplateInput,
  type LessonReadyTemplateInput,
} from "./templates.js";

export type { LessonCounts };

export type SendLessonReadyEmailInput = LessonReadyTemplateInput & {
  to: string;
  idempotencyKey: string;
};

export type SendLessonFailedEmailInput = LessonFailedTemplateInput & {
  to: string;
  idempotencyKey: string;
};

// Lesson-scoped dispatch wrappers. They render the template, send via Resend,
// and return the typed result so callers can persist `email_sent_at` (success)
// or `error` (failure) without re-implementing template logic.
export async function sendLessonReadyEmail(
  input: SendLessonReadyEmailInput,
): Promise<SendEmailResult> {
  const rendered = renderLessonReadyEmail(input);
  return sendEmail({
    to: input.to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    idempotencyKey: input.idempotencyKey,
  });
}

export async function sendLessonFailedEmail(
  input: SendLessonFailedEmailInput,
): Promise<SendEmailResult> {
  const rendered = renderLessonFailedEmail(input);
  return sendEmail({
    to: input.to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    idempotencyKey: input.idempotencyKey,
  });
}

// Pluggable surface for tests and future channels (push, SMS). The pipeline
// notification layer depends on this shape, not the concrete Resend calls, so
// unit tests can capture intent without touching the network.
export type LessonEmailer = {
  sendReady(input: SendLessonReadyEmailInput): Promise<SendEmailResult>;
  sendFailed(input: SendLessonFailedEmailInput): Promise<SendEmailResult>;
};

export function defaultLessonEmailer(): LessonEmailer {
  return {
    sendReady: sendLessonReadyEmail,
    sendFailed: sendLessonFailedEmail,
  };
}
