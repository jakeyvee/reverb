import type { Json, TablesInsert } from "@reverb/db/types";
import type { LessonNotificationKind } from "@reverb/domain/schemas/notifications";
import type { JobRow, ServiceClient } from "./state.js";
import type { PipelineLogger } from "./logger.js";

// Each member of the lesson's household gets one in-app notification row per
// (lesson, kind). The unique index
// `notification_events_lesson_kind_uniq (user_id, lesson_id, kind)` lets us
// upsert with `on conflict do nothing` so retries that re-finish or re-fail
// the same lesson never duplicate rows.
//
// Returns the number of rows actually written (zero on conflict / dedupe).
export async function recordLessonNotification(
  supabase: ServiceClient,
  job: JobRow,
  kind: LessonNotificationKind,
  extras: { errorSummary?: string | null; stage?: string | null } = {},
  logger?: PipelineLogger,
): Promise<number> {
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
    return 0;
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
    return 0;
  }
  const recipients = profiles ?? [];
  if (recipients.length === 0) return 0;

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
    .select("id");
  if (insertError) {
    logger?.error("notifications: failed to record in-app event", {
      lessonId,
      kind,
      message: insertError.message,
    });
    return 0;
  }
  return written?.length ?? 0;
}
