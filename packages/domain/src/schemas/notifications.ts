import { z } from "zod";

// Mirrors the public.notification_event_kind enum. Streak / session / milestone
// kinds are emitted by future jobs; lesson_ready and lesson_failed are written
// from the lesson processing pipeline (VOL-114).
export const NOTIFICATION_EVENT_KINDS = [
  "streak_reminder",
  "session_due",
  "lesson_ready",
  "lesson_failed",
  "milestone",
] as const;

export type NotificationEventKind = (typeof NOTIFICATION_EVENT_KINDS)[number];

export const NotificationEventKindSchema = z.enum(NOTIFICATION_EVENT_KINDS);

// Mirrors public.notification_channel. `in_app` is the only channel rendered
// today; email/push come later.
export const NOTIFICATION_CHANNELS = ["push", "email", "in_app"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

// Lesson-scoped kinds are the ones the in-app surface paginates over. Other
// kinds (streak reminders, etc.) may still appear once they're wired up.
export const LESSON_NOTIFICATION_KINDS = ["lesson_ready", "lesson_failed"] as const;
export type LessonNotificationKind = (typeof LESSON_NOTIFICATION_KINDS)[number];

export function isLessonNotificationKind(
  kind: NotificationEventKind,
): kind is LessonNotificationKind {
  return kind === "lesson_ready" || kind === "lesson_failed";
}

const KIND_LABELS: Record<NotificationEventKind, string> = {
  streak_reminder: "Streak reminder",
  session_due: "Session due",
  lesson_ready: "Lesson ready",
  lesson_failed: "Lesson failed",
  milestone: "Milestone",
};

export function notificationKindLabel(kind: NotificationEventKind): string {
  return KIND_LABELS[kind];
}
