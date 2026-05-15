import { createServiceRoleClient } from "@reverb/db/server";
import type { Tables } from "@reverb/db/types";
import { LESSON_AUDIO_BUCKET, type LessonAudioExtension } from "@reverb/domain/schemas/upload";
import {
  type LessonProcessingStage,
  type LessonProcessingStatus,
  lessonStageIndex,
} from "@reverb/domain/schemas/lesson-status";
import type { StageCompletion, StageCompletionMap, WorkerStage } from "./types.js";

export type ServiceClient = ReturnType<typeof createServiceRoleClient>;

export type JobRow = Tables<"lesson_jobs">;
export type LessonFileRow = Tables<"lesson_files">;

// Signed URL TTL for the source audio handed to step functions. 90 minutes is
// the maximum lesson length plus headroom for the longest step (transcription).
const AUDIO_SIGNED_URL_TTL_SECONDS = 60 * 120;

export type SourceAudio = {
  bucket: string;
  storagePath: string;
  mimeType: string | null;
  byteSize: number | null;
  durationMs: number | null;
  // Short-lived signed URL the steps fetch through. Renewed every run, so a
  // stale token from a prior attempt never leaks into a retry.
  signedUrl: string;
};

export function createWorkerClient(): ServiceClient {
  return createServiceRoleClient();
}

export async function loadJobByLesson(supabase: ServiceClient, lessonId: string): Promise<JobRow> {
  const { data, error } = await supabase
    .from("lesson_jobs")
    .select("*")
    .eq("lesson_id", lessonId)
    .single();
  if (error || !data) {
    throw new Error(
      `Could not load lesson_jobs row for lesson ${lessonId}: ${error?.message ?? "not found"}`,
    );
  }
  return data;
}

export async function loadSourceAudio(
  supabase: ServiceClient,
  lessonId: string,
): Promise<SourceAudio> {
  const { data, error } = await supabase
    .from("lesson_files")
    .select("storage_bucket, storage_path, mime_type, byte_size, duration_ms")
    .eq("lesson_id", lessonId)
    .eq("kind", "audio_source")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not load audio_source file: ${error.message}`);
  }
  if (!data) {
    throw new Error(`Lesson ${lessonId} has no audio_source row`);
  }
  if (data.storage_bucket !== LESSON_AUDIO_BUCKET) {
    throw new Error(
      `audio_source bucket mismatch: expected ${LESSON_AUDIO_BUCKET}, got ${data.storage_bucket}`,
    );
  }

  const { data: signed, error: signError } = await supabase.storage
    .from(data.storage_bucket)
    .createSignedUrl(data.storage_path, AUDIO_SIGNED_URL_TTL_SECONDS);
  if (signError || !signed) {
    throw new Error(
      `Could not create a signed URL for ${data.storage_path}: ${signError?.message ?? "no url"}`,
    );
  }

  return {
    bucket: data.storage_bucket,
    storagePath: data.storage_path,
    mimeType: data.mime_type,
    byteSize: data.byte_size,
    durationMs: data.duration_ms,
    signedUrl: signed.signedUrl,
  };
}

// Begin a run attempt: bump the counter, stamp `started_at` on first attempt,
// clear any stale failure summary, and record the Trigger.dev run id so the
// status UI can deep-link into the dashboard if needed.
export async function startRun(
  supabase: ServiceClient,
  job: JobRow,
  triggerRunId: string | null,
): Promise<JobRow> {
  const startedAt = job.started_at ?? new Date().toISOString();
  const { data, error } = await supabase
    .from("lesson_jobs")
    .update({
      attempt_count: (job.attempt_count ?? 0) + 1,
      started_at: startedAt,
      trigger_run_id: triggerRunId,
      error_summary: null,
      failed_at: null,
    })
    .eq("id", job.id)
    .select("*")
    .single();
  if (error || !data) {
    throw new Error(`Could not start run for job ${job.id}: ${error?.message ?? "no row"}`);
  }
  return data;
}

export function getCompletedStages(metadata: JobRow["provider_metadata"]): StageCompletionMap {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const stages = (metadata as Record<string, unknown>).stages;
  if (!stages || typeof stages !== "object" || Array.isArray(stages)) return {};
  return stages as StageCompletionMap;
}

export function isStageCompleted(
  metadata: JobRow["provider_metadata"],
  stage: WorkerStage,
): boolean {
  return Boolean(getCompletedStages(metadata)[stage]?.completed_at);
}

// Status moves monotonically forward, except that `failed` is allowed to
// transition into any later stage on retry. We reject regressions to avoid a
// late-arriving worker writing over a finished run.
export async function advanceStatus(
  supabase: ServiceClient,
  job: JobRow,
  next: LessonProcessingStage,
): Promise<JobRow> {
  if (job.status === next) return job;
  if (job.status !== "failed" && job.status !== "queued") {
    const currentIdx = lessonStageIndex(job.status as LessonProcessingStage);
    const nextIdx = lessonStageIndex(next);
    if (nextIdx < currentIdx) {
      // Idempotent re-entry: the row is already past this stage.
      return job;
    }
  }

  const { data, error } = await supabase
    .from("lesson_jobs")
    .update({ status: next })
    .eq("id", job.id)
    .select("*")
    .single();
  if (error || !data) {
    throw new Error(`Could not advance job ${job.id} to ${next}: ${error?.message ?? "no row"}`);
  }
  return data;
}

// Stage completion is the source of truth for "have we done this work?".
// Persisted under `provider_metadata.stages.<stage>` so a retry can skip it.
export async function markStageCompleted(
  supabase: ServiceClient,
  job: JobRow,
  stage: WorkerStage,
  details?: Record<string, unknown>,
): Promise<JobRow> {
  const baseMetadata = providerMetadataObject(job.provider_metadata);
  const existing = getCompletedStages(job.provider_metadata);
  const completion: StageCompletion = { completed_at: new Date().toISOString() };
  const stages: StageCompletionMap = { ...existing, [stage]: completion };
  const nextMetadata = {
    ...baseMetadata,
    stages,
    ...(details ? { [`${stage}_details`]: details } : {}),
  };

  const { data, error } = await supabase
    .from("lesson_jobs")
    .update({ provider_metadata: nextMetadata })
    .eq("id", job.id)
    .select("*")
    .single();
  if (error || !data) {
    throw new Error(
      `Could not mark stage ${stage} complete for job ${job.id}: ${error?.message ?? "no row"}`,
    );
  }
  return data;
}

export async function completeRun(supabase: ServiceClient, job: JobRow): Promise<JobRow> {
  const { data, error } = await supabase
    .from("lesson_jobs")
    .update({
      status: "ready" satisfies LessonProcessingStatus,
      finished_at: new Date().toISOString(),
      error_summary: null,
      failed_at: null,
    })
    .eq("id", job.id)
    .select("*")
    .single();
  if (error || !data) {
    throw new Error(`Could not complete job ${job.id}: ${error?.message ?? "no row"}`);
  }
  return data;
}

export async function failRun(
  supabase: ServiceClient,
  job: JobRow,
  stage: WorkerStage | null,
  errorSummary: string,
): Promise<JobRow> {
  const baseMetadata = providerMetadataObject(job.provider_metadata);
  const nextMetadata = {
    ...baseMetadata,
    last_failure: {
      stage,
      message: errorSummary,
      failed_at: new Date().toISOString(),
    },
  };
  const { data, error } = await supabase
    .from("lesson_jobs")
    .update({
      status: "failed" satisfies LessonProcessingStatus,
      failed_at: new Date().toISOString(),
      error_summary: errorSummary,
      provider_metadata: nextMetadata,
    })
    .eq("id", job.id)
    .select("*")
    .single();
  if (error || !data) {
    // Surface the original error, not the bookkeeping failure.
    console.error(
      `[lesson-pipeline] failed to record failure on job ${job.id}: ${error?.message ?? "no row"}`,
    );
    return {
      ...job,
      status: "failed",
      error_summary: errorSummary,
      provider_metadata: nextMetadata,
    };
  }
  return data;
}

// Identify the stage a previous attempt died inside, if any. Read from
// `provider_metadata.last_failure.stage`. Returns null when the failure was
// recorded before the first stage transition (e.g. could not load the source
// audio) or when the metadata is missing.
export function lastFailureStage(job: JobRow): WorkerStage | null {
  const meta = providerMetadataObject(job.provider_metadata);
  const lastFailure = meta.last_failure;
  if (!lastFailure || typeof lastFailure !== "object" || Array.isArray(lastFailure)) return null;
  const stage = (lastFailure as Record<string, unknown>).stage;
  if (!stage || typeof stage !== "string") return null;
  if (!(stage in STAGE_RESET_HOOKS)) return null;
  return stage as WorkerStage;
}

// Stage resets are the "replace derived rows for that phase" half of VOL-114:
// before a retry re-runs a previously failed stage, we (a) clear its
// completion marker so the step actually executes, and (b) wipe any
// per-stage derived rows that aren't safe to leave behind. Steps that always
// upsert on a deterministic natural key (transcript_segments on
// (lesson_id, segment_index), vocab audio at a deterministic storage path)
// don't need anything here — the unique index keeps replays safe. Stages that
// insert rows without a natural key (extraction_runs is the obvious one)
// register a hook here so a retry replaces rather than appends.
export type StageResetHook = (supabase: ServiceClient, lessonId: string) => Promise<void>;

const STAGE_RESET_HOOKS: Record<WorkerStage, StageResetHook> = {
  transcribing: async () => {
    // Transcript writes are upserts keyed on (lesson_id, segment_index) and
    // (segment_id, word_index). A retry simply overwrites the same rows, so
    // there's nothing to delete; leaving the rows in place keeps any review-
    // clip storage paths that already point at them stable.
  },
  diarizing: async (supabase, lessonId) => {
    // Diarization updates segment rows one by one. If a provider or DB error
    // interrupts the stage, a retry must not combine stale labels from the
    // failed attempt with a fresh LLM response.
    const { error } = await supabase
      .from("transcript_segments")
      .update({
        speaker: null,
        speaker_confidence: null,
        speaker_notes: null,
        speaker_low_priority: false,
      })
      .eq("lesson_id", lessonId);
    if (error) {
      throw new Error(`Could not reset diarization labels for lesson ${lessonId}: ${error.message}`);
    }
  },
  extracting: async (supabase, lessonId) => {
    // Wipe every derived row the extraction step writes for this lesson so a
    // retry replaces the previous attempt rather than appending duplicates.
    // Order matters: grammar_exercises FK-cascades from grammar_patterns, and
    // cards/user_known_words cascade from vocab_items, so deleting the parents
    // is enough — but we still scope by lesson_id rather than truncating.
    //
    // Safety: this only runs when the orchestrator is resuming a `failed`
    // job (see `runLessonPipeline`). A successful re-entry short-circuits
    // before reaching this hook, so a user who has already started
    // practicing cannot have their cards wiped by a re-run.
    const tables = [
      "extraction_runs",
      "vocab_items",
      "grammar_patterns",
      "dialogue_clips",
      "teacher_corrections",
    ] as const;
    for (const table of tables) {
      const { error } = await supabase.from(table).delete().eq("lesson_id", lessonId);
      if (error) {
        throw new Error(`Could not reset ${table} for lesson ${lessonId}: ${error.message}`);
      }
    }
  },
  generating_audio: async () => {
    // The TTS step writes clips to deterministic storage paths
    // (`{householdId}/{lessonId}/clips/{cardId}.mp3`) and updates
    // vocab_items.audio_storage_path in place. A retry overwrites the object
    // and the row, so we do not need to clean anything up here.
  },
};

export function getStageResetHook(stage: WorkerStage): StageResetHook {
  return STAGE_RESET_HOOKS[stage];
}

// Prepare a previously-failed job for a fresh attempt: clear the stage's
// completion marker (so `runStage` re-runs the step instead of short-
// circuiting) and replace any derived rows the prior attempt left behind.
// Safe to call when the job has never failed — the helper short-circuits if
// `last_failure.stage` is null.
export async function resetFailedStage(supabase: ServiceClient, job: JobRow): Promise<JobRow> {
  if (job.status !== "failed") return job;
  const stage = lastFailureStage(job);
  if (!stage) return job;

  await STAGE_RESET_HOOKS[stage](supabase, job.lesson_id);

  const baseMetadata = providerMetadataObject(job.provider_metadata);
  const stages = { ...getCompletedStages(job.provider_metadata) };
  delete stages[stage];
  const nextMetadata = { ...baseMetadata, stages };

  const { data, error } = await supabase
    .from("lesson_jobs")
    .update({ provider_metadata: nextMetadata })
    .eq("id", job.id)
    .select("*")
    .single();
  if (error || !data) {
    throw new Error(
      `Could not clear completion marker for stage ${stage}: ${error?.message ?? "no row"}`,
    );
  }
  return data;
}

function providerMetadataObject(meta: JobRow["provider_metadata"]): Record<string, unknown> {
  if (meta && typeof meta === "object" && !Array.isArray(meta)) {
    return meta as Record<string, unknown>;
  }
  return {};
}

// Storage path conventions (kept here so step implementations stay in sync).
export const storagePaths = {
  // {householdId}/{lessonId}/source.{ext}
  source: (householdId: string, lessonId: string, ext: LessonAudioExtension) =>
    `${householdId}/${lessonId}/source.${ext}`,
  // {householdId}/{lessonId}/clips/{cardId}.mp3 — placeholder, used by future TTS step.
  clip: (householdId: string, lessonId: string, cardId: string) =>
    `${householdId}/${lessonId}/clips/${cardId}.mp3`,
};
