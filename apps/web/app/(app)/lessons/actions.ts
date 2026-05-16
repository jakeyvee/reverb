"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createServiceRoleClient } from "@reverb/db/server";
import type { Json } from "@reverb/db/types";
import { getUser } from "@/lib/auth/get-user";
import { getProfile } from "@/lib/auth/get-profile";
import { enqueueLessonProcessing } from "@/lib/jobs/enqueue-lesson-processing";
import { isDemoLessonMetadata } from "@/lib/lessons/demo";

const RetryInputSchema = z.object({
  lessonId: z.string().uuid(),
});

export type RetryLessonProcessingInput = z.infer<typeof RetryInputSchema>;
export type RetryLessonProcessingResult = { ok: true } | { ok: false; error: string };

type JobMetadata = {
  stages?: Record<string, { completed_at?: string }>;
  last_failure?: { stage?: string | null; message?: string };
  last_reprocess?: { requested_at: string; requested_by: string };
  [key: string]: unknown;
};

// Reuse the original uploaded audio and resume the pipeline. The server
// action:
//   1. Confirms the caller owns the lesson (Vincent-only — only the upload
//      account can drive retries today).
//   2. Clears the completion marker for the stage that failed so the worker
//      actually re-runs it, instead of short-circuiting on stale metadata.
//   3. Drops any extraction_runs rows the previous attempt left behind —
//      stages that upsert on natural keys are safe to leave alone.
//   4. Flips the row back to `queued` and re-enqueues Trigger.dev using the
//      lesson's stable idempotency key, so duplicate dispatches coalesce.
export async function retryLessonProcessing(
  input: RetryLessonProcessingInput,
): Promise<RetryLessonProcessingResult> {
  const parsed = RetryInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Invalid request." };
  }

  const user = await getUser();
  if (!user || !user.isAllowed) {
    return { ok: false, error: "Sign in to retry processing." };
  }
  if (!user.isVincent) {
    return { ok: false, error: "Only the upload account can retry processing." };
  }

  const profile = await getProfile(user.id);
  if (!profile) {
    return { ok: false, error: "Could not resolve your household." };
  }

  const supabase = createServiceRoleClient();

  // Confirm the lesson belongs to the caller's household before touching jobs.
  // Service role bypasses RLS, so this scope check is what protects the row.
  const { data: lesson, error: lessonError } = await supabase
    .from("lessons")
    .select("id, household_id, metadata")
    .eq("id", parsed.data.lessonId)
    .maybeSingle();
  if (lessonError || !lesson) {
    return { ok: false, error: "Lesson not found." };
  }
  if (lesson.household_id !== profile.householdId) {
    return { ok: false, error: "Lesson not found." };
  }
  // Demo lessons are pre-seeded fixtures (VOL-124) that never go through the
  // worker pipeline. Refuse retry rather than queue an audio-less run.
  if (isDemoLessonMetadata(lesson.metadata)) {
    return { ok: false, error: "Demo lessons cannot be reprocessed." };
  }

  const { data: job, error: jobError } = await supabase
    .from("lesson_jobs")
    .select("status, attempt_count, provider_metadata")
    .eq("lesson_id", parsed.data.lessonId)
    .maybeSingle();
  if (jobError) {
    return { ok: false, error: "Could not read the job." };
  }
  if (!job) {
    return { ok: false, error: "Nothing to retry." };
  }
  if (job.status !== "failed") {
    return { ok: false, error: "Only failed lessons can be retried." };
  }

  const metadata: JobMetadata =
    job.provider_metadata &&
    typeof job.provider_metadata === "object" &&
    !Array.isArray(job.provider_metadata)
      ? (job.provider_metadata as JobMetadata)
      : {};
  const failedStage =
    typeof metadata.last_failure?.stage === "string" ? metadata.last_failure.stage : null;

  // The worker's `STAGE_RESET_HOOKS.extracting` now handles every reset that
  // belongs to the extracting phase (grammar/dialogue truncation +
  // marking prior extraction_runs as superseded inside the step itself).
  // VOL-136 made the row-management explicit there because corrections need
  // an upsert path that can't be expressed as a blanket delete; nothing for
  // this action to do for that stage anymore.

  // Clear the failed stage's completion marker — the worker uses it to skip
  // already-done stages, and we want this specific stage to actually re-run.
  const stages = metadata.stages ? { ...metadata.stages } : {};
  if (failedStage) delete stages[failedStage];
  const nextMetadata: JobMetadata = { ...metadata, stages };

  const { error: updateError } = await supabase
    .from("lesson_jobs")
    .update({
      status: "queued",
      error_summary: null,
      failed_at: null,
      finished_at: null,
      provider_metadata: nextMetadata as unknown as Json,
    })
    .eq("lesson_id", parsed.data.lessonId);
  if (updateError) {
    return { ok: false, error: "Could not re-queue the lesson." };
  }

  await supabase.from("lessons").update({ status: "processing" }).eq("id", parsed.data.lessonId);

  // Dispatch the worker. Same idempotency key as the original upload, so
  // double-clicking retry coalesces to a single Trigger.dev run.
  const enqueue = await enqueueLessonProcessing(parsed.data.lessonId);
  if (enqueue.ok && !enqueue.skipped && enqueue.runId) {
    const { error: tagError } = await supabase
      .from("lesson_jobs")
      .update({ trigger_run_id: enqueue.runId })
      .eq("lesson_id", parsed.data.lessonId);
    if (tagError) {
      console.error("[retry] could not record trigger_run_id", tagError);
    }
  } else if (!enqueue.ok) {
    // Re-park the row as failed with the enqueue error so the user sees the
    // failure surface immediately. Without this the row sits in `queued`
    // with no worker polling.
    const summary = `Could not enqueue retry: ${enqueue.error}`;
    await supabase
      .from("lesson_jobs")
      .update({
        status: "failed",
        failed_at: new Date().toISOString(),
        error_summary: summary,
      })
      .eq("lesson_id", parsed.data.lessonId);
    return { ok: false, error: summary };
  }

  revalidatePath("/");
  revalidatePath("/lessons");
  revalidatePath("/upload");
  revalidatePath("/notifications");

  return { ok: true };
}

const ReprocessInputSchema = z.object({
  lessonId: z.string().uuid(),
});

export type ReprocessLessonInput = z.infer<typeof ReprocessInputSchema>;
export type ReprocessLessonResult = { ok: true } | { ok: false; error: string };

// Vincent-only "re-run extraction" path. Sister action to retryLessonProcessing
// but for already-ready lessons whose extraction quality we want to re-derive
// — e.g. after a prompt change. The contract:
//
//   1. Same auth + household scope checks as retryLessonProcessing (only the
//      upload account drives reprocessing).
//   2. The lesson must already be `ready` or `failed` — there's no point
//      re-extracting a job that's still mid-pipeline, and queueing on top of
//      an in-flight run would create idempotency-key contention.
//   3. Reset the extracting + generating_audio completion markers so the
//      worker actually re-runs those stages instead of short-circuiting.
//      Transcribing + diarizing stay intact: the audio hasn't changed, so
//      re-running them would burn provider credits for no benefit.
//   4. Flip the row back to the extracting stage and re-enqueue. The
//      worker's existing version-bump logic in `steps.ts` handles the rest:
//      prior extraction_runs get superseded, vocab dedupe keeps cards
//      stable, corrections upsert keeps correction_drills stable.
export async function reprocessLesson(input: ReprocessLessonInput): Promise<ReprocessLessonResult> {
  const parsed = ReprocessInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Invalid request." };
  }

  const user = await getUser();
  if (!user || !user.isAllowed) {
    return { ok: false, error: "Sign in to reprocess." };
  }
  if (!user.isVincent) {
    return { ok: false, error: "Only the upload account can reprocess a lesson." };
  }

  const profile = await getProfile(user.id);
  if (!profile) {
    return { ok: false, error: "Could not resolve your household." };
  }

  const supabase = createServiceRoleClient();

  const { data: lesson, error: lessonError } = await supabase
    .from("lessons")
    .select("id, household_id, metadata")
    .eq("id", parsed.data.lessonId)
    .maybeSingle();
  if (lessonError || !lesson) {
    return { ok: false, error: "Lesson not found." };
  }
  if (lesson.household_id !== profile.householdId) {
    return { ok: false, error: "Lesson not found." };
  }
  // Demo seed lessons (VOL-124) never participate in the extraction pipeline.
  if (isDemoLessonMetadata(lesson.metadata)) {
    return { ok: false, error: "Demo lessons cannot be reprocessed." };
  }

  const { data: job, error: jobError } = await supabase
    .from("lesson_jobs")
    .select("status, provider_metadata")
    .eq("lesson_id", parsed.data.lessonId)
    .maybeSingle();
  if (jobError) {
    return { ok: false, error: "Could not read the job." };
  }
  if (!job) {
    return { ok: false, error: "This lesson has not been processed yet." };
  }
  if (job.status !== "ready" && job.status !== "failed") {
    return { ok: false, error: "Wait for the current run to finish before reprocessing." };
  }

  const metadata: JobMetadata =
    job.provider_metadata &&
    typeof job.provider_metadata === "object" &&
    !Array.isArray(job.provider_metadata)
      ? (job.provider_metadata as JobMetadata)
      : {};

  // Clear the stages we want to actually re-run. Transcribing + diarizing
  // are deliberately kept — the audio is unchanged, so re-running them
  // burns credits without adding value. The worker's stage reset hook for
  // extracting handles wiping grammar/dialogue + marking prior
  // extraction_runs superseded, so we only need to invalidate the markers
  // here.
  const stages = metadata.stages ? { ...metadata.stages } : {};
  delete stages.extracting;
  delete stages.generating_audio;

  const nextMetadata: JobMetadata = {
    ...metadata,
    stages,
    last_reprocess: {
      requested_at: new Date().toISOString(),
      requested_by: user.id,
    },
  };

  const { error: updateError } = await supabase
    .from("lesson_jobs")
    .update({
      // `extracting` is the stage the worker will resume at because that's
      // the earliest unfinished stage after the markers above were cleared.
      // Status is the public-facing label the UI renders, so we set it to
      // match.
      status: "extracting",
      error_summary: null,
      failed_at: null,
      finished_at: null,
      provider_metadata: nextMetadata as unknown as Json,
    })
    .eq("lesson_id", parsed.data.lessonId);
  if (updateError) {
    return { ok: false, error: "Could not re-queue the lesson." };
  }

  await supabase.from("lessons").update({ status: "processing" }).eq("id", parsed.data.lessonId);

  const enqueue = await enqueueLessonProcessing(parsed.data.lessonId);
  if (enqueue.ok && !enqueue.skipped && enqueue.runId) {
    const { error: tagError } = await supabase
      .from("lesson_jobs")
      .update({ trigger_run_id: enqueue.runId })
      .eq("lesson_id", parsed.data.lessonId);
    if (tagError) {
      console.error("[reprocess] could not record trigger_run_id", tagError);
    }
  } else if (!enqueue.ok) {
    const summary = `Could not enqueue reprocess: ${enqueue.error}`;
    await supabase
      .from("lesson_jobs")
      .update({
        status: "failed",
        failed_at: new Date().toISOString(),
        error_summary: summary,
      })
      .eq("lesson_id", parsed.data.lessonId);
    return { ok: false, error: summary };
  }

  revalidatePath("/");
  revalidatePath("/lessons");
  revalidatePath(`/lessons/${parsed.data.lessonId}`);
  revalidatePath("/notifications");

  return { ok: true };
}

const MarkNotificationsReadInputSchema = z.object({
  ids: z.array(z.string().uuid()).max(100).optional(),
});

export type MarkNotificationsReadInput = z.infer<typeof MarkNotificationsReadInputSchema>;
export type MarkNotificationsReadResult =
  | { ok: true; updated: number }
  | { ok: false; error: string };

// Mark a user's in-app notifications as read. With no `ids`, marks every
// unread notification for the current user — the "Mark all read" affordance.
export async function markNotificationsRead(
  input: MarkNotificationsReadInput = {},
): Promise<MarkNotificationsReadResult> {
  const parsed = MarkNotificationsReadInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Invalid request." };
  }

  const user = await getUser();
  if (!user || !user.isAllowed) {
    return { ok: false, error: "Sign in to manage notifications." };
  }

  const supabase = createServiceRoleClient();
  const ids = parsed.data.ids;
  const readAt = new Date().toISOString();

  let query = supabase
    .from("notification_events")
    .update({ read_at: readAt })
    .eq("user_id", user.id)
    .is("read_at", null);
  if (ids && ids.length > 0) query = query.in("id", ids);

  const { data, error } = await query.select("id");
  if (error) {
    return { ok: false, error: "Could not update notifications." };
  }

  revalidatePath("/");
  revalidatePath("/lessons");
  revalidatePath("/notifications");

  return { ok: true, updated: data?.length ?? 0 };
}
