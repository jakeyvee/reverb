import type { Json, TablesInsert } from "@reverb/db/types";
import type { LessonNotificationKind } from "@reverb/domain/schemas/notifications";
import type {
  LessonEmailer,
  LessonCounts,
  SendLessonFailedEmailInput,
  SendLessonReadyEmailInput,
} from "@reverb/email";
import type { JobRow, ServiceClient } from "./state.js";
import type { PipelineLogger } from "./logger.js";

// Each member of the lesson's household gets one in-app notification row per
// (lesson, kind). The unique index
// `notification_events_lesson_kind_uniq (user_id, lesson_id, kind)` lets us
// upsert with `on conflict do nothing` so retries that re-finish or re-fail
// the same lesson never duplicate rows.
//
// Returns the rows that were actually inserted (empty on conflict / dedupe).
// Email dispatch keys off the inserted rows so a retry pass that re-enters
// after the row is already present won't re-send the email either.
export type RecordedNotification = {
  id: string;
  userId: string;
  lessonId: string;
  kind: LessonNotificationKind;
};

export async function recordLessonNotification(
  supabase: ServiceClient,
  job: JobRow,
  kind: LessonNotificationKind,
  extras: { errorSummary?: string | null; stage?: string | null } = {},
  logger?: PipelineLogger,
): Promise<RecordedNotification[]> {
  const lessonId = job.lesson_id;
  const { data: lesson, error: lessonError } = await supabase
    .from("lessons")
    .select("household_id")
    .eq("id", lessonId)
    .maybeSingle();
  if (lessonError || !lesson) {
    logger?.error("notifications: could not load lesson", {
      lessonId,
      message: lessonError?.message ?? "no lesson row",
    });
    return [];
  }

  const { data: profiles, error: profilesError } = await supabase
    .from("profiles")
    .select("id")
    .eq("household_id", lesson.household_id);
  if (profilesError) {
    logger?.error("notifications: could not load household profiles", {
      lessonId,
      message: profilesError.message,
    });
    return [];
  }
  const recipients = profiles ?? [];
  if (recipients.length === 0) return [];

  const payload: Record<string, Json> = {
    lesson_id: lessonId,
    attempt: job.attempt_count,
  };
  if (extras.stage !== undefined) payload.stage = extras.stage;
  if (extras.errorSummary !== undefined) payload.error_summary = extras.errorSummary;

  const rows: TablesInsert<"notification_events">[] = recipients.map((p) => ({
    user_id: p.id,
    lesson_id: lessonId,
    kind,
    channel: "in_app",
    status: "sent",
    sent_at: new Date().toISOString(),
    payload: payload as Json,
  }));

  const { data: written, error: insertError } = await supabase
    .from("notification_events")
    .upsert(rows, {
      onConflict: "user_id,lesson_id,kind",
      ignoreDuplicates: true,
    })
    .select("id, user_id, lesson_id, kind");
  if (insertError) {
    logger?.error("notifications: failed to record in-app event", {
      lessonId,
      kind,
      message: insertError.message,
    });
    return [];
  }
  return (written ?? []).map((row) => ({
    id: row.id,
    userId: row.user_id,
    lessonId: row.lesson_id ?? lessonId,
    kind: row.kind as LessonNotificationKind,
  }));
}

// ---------------------------------------------------------------------------
// Email dispatch
// ---------------------------------------------------------------------------
//
// Why this is a separate function rather than inlined into the orchestrator:
//   * Idempotency lives on the notification rows themselves. Re-running the
//     orchestrator that re-fails the same lesson will write zero new rows
//     (the unique index swallows the conflict), so `recordedNotifications`
//     will be empty and we send no email.
//   * Email failures must not roll back lesson processing. Wrapping the calls
//     in this helper keeps the failure surface obvious: we always log, never
//     throw.
//   * Production wiring (auth.admin lookup for ready emails, env-based Vincent
//     address for failed) lives in `services.ts`; tests inject stubs.

export type LessonSnapshot = {
  title: string;
  counts: LessonCounts;
};

export type EmailRecipientResolver = (userId: string) => Promise<string | null>;

export type VincentEmailResolver = () => string | null;

export type EmailDispatchContext = {
  supabase: ServiceClient;
  logger: PipelineLogger;
  emailer: LessonEmailer;
  resolveRecipientEmail: EmailRecipientResolver;
  resolveVincentEmail: VincentEmailResolver;
};

// Send lesson_ready emails to each member whose in-app row was just written.
// One Resend request per recipient, idempotency-keyed on the notification row
// id so a re-dispatch (HTTP retry, transient error) coalesces server-side.
export async function dispatchLessonReadyEmails(
  ctx: EmailDispatchContext,
  job: JobRow,
  notifications: RecordedNotification[],
): Promise<void> {
  if (notifications.length === 0) return;

  const snapshot = await loadLessonSnapshot(ctx.supabase, job.lesson_id, ctx.logger);
  if (!snapshot) return;

  for (const notif of notifications) {
    const to = await ctx.resolveRecipientEmail(notif.userId);
    if (!to) {
      ctx.logger.info("emails: no address resolved for recipient — skipping ready email", {
        userId: notif.userId,
        lessonId: job.lesson_id,
      });
      continue;
    }
    const input: SendLessonReadyEmailInput = {
      to,
      lessonTitle: snapshot.title,
      lessonId: job.lesson_id,
      counts: snapshot.counts,
      idempotencyKey: `lesson_ready:${notif.id}`,
    };
    const result = await ctx.emailer.sendReady(input);
    if (!result.ok) {
      ctx.logger.error("emails: lesson_ready dispatch failed", {
        userId: notif.userId,
        lessonId: job.lesson_id,
        notificationId: notif.id,
        status: result.status,
        message: result.error,
      });
    } else {
      ctx.logger.info("emails: lesson_ready dispatched", {
        userId: notif.userId,
        lessonId: job.lesson_id,
        notificationId: notif.id,
        messageId: result.messageId,
      });
    }
  }
}

// Vincent gets a single failure email per lesson regardless of how many
// household members got the in-app row. We key idempotency on the lesson id
// alone so retries that re-fail produce zero new emails (the in-app upsert
// returns no inserted rows on the second failure).
export async function dispatchLessonFailedEmail(
  ctx: EmailDispatchContext,
  job: JobRow,
  notifications: RecordedNotification[],
  details: { errorSummary: string | null; stage: string | null },
): Promise<void> {
  if (notifications.length === 0) return;

  const to = ctx.resolveVincentEmail();
  if (!to) {
    ctx.logger.info("emails: VINCENT_UPLOAD_EMAIL not set — skipping lesson_failed email", {
      lessonId: job.lesson_id,
    });
    return;
  }

  const title = await loadLessonTitle(ctx.supabase, job.lesson_id, ctx.logger);
  if (!title) return;

  const input: SendLessonFailedEmailInput = {
    to,
    lessonTitle: title,
    lessonId: job.lesson_id,
    errorSummary: details.errorSummary,
    stage: details.stage,
    attempt: job.attempt_count,
    idempotencyKey: `lesson_failed:${job.lesson_id}:${job.attempt_count}`,
  };
  const result = await ctx.emailer.sendFailed(input);
  if (!result.ok) {
    ctx.logger.error("emails: lesson_failed dispatch failed", {
      lessonId: job.lesson_id,
      attempt: job.attempt_count,
      status: result.status,
      message: result.error,
    });
  } else {
    ctx.logger.info("emails: lesson_failed dispatched", {
      lessonId: job.lesson_id,
      attempt: job.attempt_count,
      messageId: result.messageId,
    });
  }
}

async function loadLessonTitle(
  supabase: ServiceClient,
  lessonId: string,
  logger: PipelineLogger,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("lessons")
    .select("title")
    .eq("id", lessonId)
    .maybeSingle();
  if (error || !data) {
    logger.error("emails: could not load lesson title", {
      lessonId,
      message: error?.message ?? "no row",
    });
    return null;
  }
  return data.title;
}

// Lesson-ready emails carry per-table counts so the recipient sees what's
// new at a glance. We query the derived tables rather than reading the
// extracting-stage details payload — the tables are the source of truth
// the in-app surface uses, so the numbers match what users actually see.
async function loadLessonSnapshot(
  supabase: ServiceClient,
  lessonId: string,
  logger: PipelineLogger,
): Promise<LessonSnapshot | null> {
  const title = await loadLessonTitle(supabase, lessonId, logger);
  if (title === null) return null;

  const counts = await loadLessonCounts(supabase, lessonId, logger);
  return { title, counts };
}

async function loadLessonCounts(
  supabase: ServiceClient,
  lessonId: string,
  logger: PipelineLogger,
): Promise<LessonCounts> {
  // Sequential reads keep the FakeSupabase test seam simple — supabase-js
  // queries hitting separate tables don't benefit meaningfully from
  // parallelism here, and the four counts are cheap.
  const newVocab = await countRows(supabase, "vocab_items", lessonId, logger);
  const grammarPatterns = await countRows(supabase, "grammar_patterns", lessonId, logger);
  const teacherCorrections = await countRows(supabase, "teacher_corrections", lessonId, logger);
  const dialogueClips = await countRows(supabase, "dialogue_clips", lessonId, logger);
  return { newVocab, grammarPatterns, teacherCorrections, dialogueClips };
}

type CountableTable =
  | "vocab_items"
  | "grammar_patterns"
  | "teacher_corrections"
  | "dialogue_clips";

async function countRows(
  supabase: ServiceClient,
  table: CountableTable,
  lessonId: string,
  logger: PipelineLogger,
): Promise<number> {
  const { data, error } = await supabase.from(table).select("id").eq("lesson_id", lessonId);
  if (error) {
    logger.error(`emails: could not count ${table}`, {
      lessonId,
      message: error.message,
    });
    return 0;
  }
  return data?.length ?? 0;
}
