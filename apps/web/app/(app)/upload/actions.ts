"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import type { ZodError } from "zod";
import { createServiceRoleClient } from "@reverb/db/server";
import {
  LESSON_AUDIO_BUCKET,
  LessonUploadFinalizeInputSchema,
  LessonUploadIntentInputSchema,
  canonicalMimeForExtension,
  extensionForMimeType,
  type LessonUploadFinalizeInput,
  type LessonUploadIntentInput,
} from "@reverb/domain/schemas/upload";
import { lessonProcessingIdempotencyKey } from "@reverb/domain/schemas/lesson-status";
import { getUser } from "@/lib/auth/get-user";
import { getProfile } from "@/lib/auth/get-profile";
import { enqueueLessonProcessing } from "@/lib/jobs/enqueue-lesson-processing";

export type PrepareUploadSuccess = {
  ok: true;
  lessonId: string;
  bucket: typeof LESSON_AUDIO_BUCKET;
  storagePath: string;
  signedUrl: string;
  token: string;
};

export type PrepareUploadError = {
  ok: false;
  error: string;
};

export type PrepareUploadResult = PrepareUploadSuccess | PrepareUploadError;

export type FinalizeUploadResult = { ok: true; lessonId: string } | { ok: false; error: string };

export async function prepareLessonUpload(
  input: LessonUploadIntentInput,
): Promise<PrepareUploadResult> {
  const user = await getUser();
  if (!user || !user.isVincent) {
    return { ok: false, error: "Only the upload account can add lessons." };
  }

  const parsed = LessonUploadIntentInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: firstZodMessage(parsed.error) };
  }

  const profile = await getProfile(user.id);
  if (!profile) {
    return { ok: false, error: "Could not resolve your household." };
  }

  const ext = extensionForMimeType(parsed.data.mimeType);
  if (!ext) {
    return { ok: false, error: "Unsupported audio type." };
  }

  const lessonId = randomUUID();
  const storagePath = `${profile.householdId}/${lessonId}/source.${ext}`;

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.storage
    .from(LESSON_AUDIO_BUCKET)
    .createSignedUploadUrl(storagePath);
  if (error || !data) {
    return { ok: false, error: "Could not start the upload. Please try again." };
  }

  return {
    ok: true,
    lessonId,
    bucket: LESSON_AUDIO_BUCKET,
    storagePath,
    signedUrl: data.signedUrl,
    token: data.token,
  };
}

export async function finalizeLessonUpload(
  input: LessonUploadFinalizeInput,
): Promise<FinalizeUploadResult> {
  const user = await getUser();
  if (!user || !user.isVincent) {
    return { ok: false, error: "Only the upload account can add lessons." };
  }

  const parsed = LessonUploadFinalizeInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: firstZodMessage(parsed.error) };
  }
  const data = parsed.data;

  const profile = await getProfile(user.id);
  if (!profile) {
    return { ok: false, error: "Could not resolve your household." };
  }

  const ext = extensionForMimeType(data.mimeType);
  if (!ext) {
    return { ok: false, error: "Unsupported audio type." };
  }

  // The path is derived deterministically, so a client that tries to lie about
  // the storage path or lesson id will end up pointing at someone else's slot
  // and the existence check below will fail. Belt-and-braces verification.
  const expectedPath = `${profile.householdId}/${data.lessonId}/source.${ext}`;
  if (data.storagePath !== expectedPath) {
    return { ok: false, error: "Upload location mismatch." };
  }

  const supabase = createServiceRoleClient();

  // Idempotency: if a previous attempt already wrote the lesson, treat retries
  // as a no-op success. Without this, a duplicate-PK error on the insert below
  // would fall into the catch path and delete the already-finalized lesson and
  // its files/jobs (cascade) plus the uploaded object.
  const { data: existing, error: existingError } = await supabase
    .from("lessons")
    .select("id, household_id, created_by")
    .eq("id", data.lessonId)
    .maybeSingle();
  if (existingError) {
    return { ok: false, error: "Could not verify the lesson." };
  }
  if (existing) {
    if (existing.household_id !== profile.householdId || existing.created_by !== user.id) {
      return { ok: false, error: "Lesson already exists." };
    }
    return { ok: true, lessonId: data.lessonId };
  }

  const folder = `${profile.householdId}/${data.lessonId}`;
  const fileName = `source.${ext}`;
  const { data: objects, error: listError } = await supabase.storage
    .from(LESSON_AUDIO_BUCKET)
    .list(folder, { limit: 5, search: fileName });
  if (listError) {
    return { ok: false, error: "Could not verify the uploaded file." };
  }
  const uploaded = objects?.find((o) => o.name === fileName);
  if (!uploaded) {
    return { ok: false, error: "Upload did not complete. Please retry." };
  }

  const canonicalMime = canonicalMimeForExtension(ext);
  try {
    const { error: lessonError } = await supabase.from("lessons").insert({
      id: data.lessonId,
      household_id: profile.householdId,
      title: data.title,
      status: "processing",
      duration_ms: data.durationMs,
      created_by: user.id,
      metadata: { source: { kind: "upload", original_filename: data.fileName } },
    });
    if (lessonError) throw lessonError;

    const { error: fileError } = await supabase.from("lesson_files").insert({
      lesson_id: data.lessonId,
      kind: "audio_source",
      storage_bucket: LESSON_AUDIO_BUCKET,
      storage_path: data.storagePath,
      mime_type: canonicalMime,
      byte_size: data.byteSize,
      duration_ms: data.durationMs,
      metadata: { original_filename: data.fileName, original_mime_type: data.mimeType },
    });
    if (fileError) throw fileError;

    const { error: jobError } = await supabase.from("lesson_jobs").insert({
      lesson_id: data.lessonId,
      status: "queued",
      idempotency_key: lessonProcessingIdempotencyKey(data.lessonId),
      payload: {
        audio: {
          bucket: LESSON_AUDIO_BUCKET,
          storage_path: data.storagePath,
          mime_type: canonicalMime,
          byte_size: data.byteSize,
          duration_ms: data.durationMs,
        },
      },
    });
    if (jobError) throw jobError;
  } catch (err) {
    await rollback(supabase, data.lessonId, data.storagePath);
    return {
      ok: false,
      error: errorMessage(err) ?? "Could not save the lesson. Please try again.",
    };
  }

  // Enqueue the long-running processing pipeline on Trigger.dev. The upload
  // itself is kept; an enqueue failure is persisted onto the lesson_jobs row
  // as a terminal `failed` status so the UI shows the error immediately
  // instead of leaving the lesson stuck in `queued` with no worker polling.
  const enqueue = await enqueueLessonProcessing(data.lessonId);
  if (enqueue.ok && !enqueue.skipped && enqueue.runId) {
    const { error: tagError } = await supabase
      .from("lesson_jobs")
      .update({ trigger_run_id: enqueue.runId })
      .eq("lesson_id", data.lessonId);
    if (tagError) {
      console.error("[upload] could not record trigger_run_id", tagError);
    }
  } else if (!enqueue.ok) {
    console.error("[upload] could not enqueue processing job", enqueue.error);
    const summary = `Could not enqueue processing job: ${enqueue.error}`;
    const { error: failError } = await supabase
      .from("lesson_jobs")
      .update({
        status: "failed",
        failed_at: new Date().toISOString(),
        error_summary: summary,
      })
      .eq("lesson_id", data.lessonId);
    if (failError) {
      console.error("[upload] could not mark job failed after enqueue error", failError);
    }
  }

  revalidatePath("/upload");
  revalidatePath("/lessons");
  revalidatePath("/");

  return { ok: true, lessonId: data.lessonId };
}

async function rollback(
  supabase: ReturnType<typeof createServiceRoleClient>,
  lessonId: string,
  storagePath: string,
): Promise<void> {
  // Cascade deletes lesson_files + lesson_jobs that may have been inserted
  // already. Failure here is logged but not surfaced — the user already sees
  // the original error and a stale row is recoverable on the worker side.
  const { error: delError } = await supabase.from("lessons").delete().eq("id", lessonId);
  if (delError) {
    console.error("[upload] rollback: lessons delete failed", delError);
  }
  const { error: storageError } = await supabase.storage
    .from(LESSON_AUDIO_BUCKET)
    .remove([storagePath]);
  if (storageError) {
    console.error("[upload] rollback: storage remove failed", storageError);
  }
}

function firstZodMessage(error: ZodError): string {
  return error.issues[0]?.message ?? "Invalid input.";
}

function errorMessage(err: unknown): string | null {
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
    return err.message;
  }
  return null;
}
