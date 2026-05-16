import { sendEmail, type SendEmailResult } from "./client.js";
import { renderStreakReminderEmail, type StreakReminderTemplateInput } from "./templates.js";

export type SendStreakReminderEmailInput = StreakReminderTemplateInput & {
  to: string;
  // The `Idempotency-Key` we hand to Resend. The cron dispatcher uses
  // `streak-reminder:<user_id>:<local_date>` so a re-fire on the same local
  // day collapses on Resend's side as well as in our own log table.
  idempotencyKey: string;
};

// Streak-reminder dispatcher. Render the template, send via Resend, return
// the typed result so the caller can log success / failure into
// streak_reminder_log + notification_events.
export async function sendStreakReminderEmail(
  input: SendStreakReminderEmailInput,
): Promise<SendEmailResult> {
  const rendered = renderStreakReminderEmail(input);
  return sendEmail({
    to: input.to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    idempotencyKey: input.idempotencyKey,
  });
}
