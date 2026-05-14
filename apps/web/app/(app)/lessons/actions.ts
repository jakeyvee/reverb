"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createServiceRoleClient } from "@reverb/db/server";
import { getUser } from "@/lib/auth/get-user";
import { getProfile } from "@/lib/auth/get-profile";

const RetryInputSchema = z.object({
  lessonId: z.string().uuid(),
});

export type RetryLessonProcessingInput = z.infer<typeof RetryInputSchema>;
export type RetryLessonProcessingResult = { ok: true } | { ok: false; error: string };

// Placeholder retry: resets the failed lesson_jobs row back to `queued`,
// bumps `attempt_count`, and clears the error summary. The worker that
// actually picks the row back up is added in a later ticket; for now this
// keeps the UI affordance from looking dead and matches VOL-108's "placeholder
// retry affordance" requirement.
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

  const profile = await getProfile(user.id);
  if (!profile) {
    return { ok: false, error: "Could not resolve your household." };
  }

  const supabase = createServiceRoleClient();

  // Confirm the lesson belongs to the caller's household before touching jobs.
  // Service role bypasses RLS, so this scope check is what protects the row.
  const { data: lesson, error: lessonError } = await supabase
    .from("lessons")
    .select("id, household_id")
    .eq("id", parsed.data.lessonId)
    .maybeSingle();
  if (lessonError || !lesson) {
    return { ok: false, error: "Lesson not found." };
  }
  if (lesson.household_id !== profile.householdId) {
    return { ok: false, error: "Lesson not found." };
  }

  const { data: job, error: jobError } = await supabase
    .from("lesson_jobs")
    .select("status, attempt_count")
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

  const { error: updateError } = await supabase
    .from("lesson_jobs")
    .update({
      status: "queued",
      error_summary: null,
      failed_at: null,
      started_at: null,
      finished_at: null,
      attempt_count: job.attempt_count + 1,
    })
    .eq("lesson_id", parsed.data.lessonId);
  if (updateError) {
    return { ok: false, error: "Could not re-queue the lesson." };
  }

  await supabase.from("lessons").update({ status: "processing" }).eq("id", parsed.data.lessonId);

  revalidatePath("/");
  revalidatePath("/lessons");
  revalidatePath("/upload");

  return { ok: true };
}
