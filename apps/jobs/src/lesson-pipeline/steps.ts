import type { JobRow, ServiceClient, SourceAudio } from "./state.js";
import { isStageCompleted, markStageCompleted } from "./state.js";
import type { PipelineLogger } from "./logger.js";
import { WORKER_STAGES, type WorkerStage } from "./types.js";

// Each stage handler is the seam where a future PR drops in the real
// implementation (Groq for transcribe, an LLM call for extract, Google TTS for
// audio synthesis, etc.). For VOL-109 we keep them as documented placeholders
// so the orchestration, idempotency, and status surfaces are testable end to
// end against the real schema and Trigger.dev runtime.
//
// Contract every step must follow:
//   1. Short-circuit if `provider_metadata.stages.<stage>` is already set.
//   2. Do its work without writing to product tables (transcript_segments,
//      cards, card_clips, notifications) unless those writes are upserts keyed
//      on a deterministic natural key. The schema's unique indexes — e.g.
//      `(lesson_id, segment_index)` on transcript_segments — make replays safe
//      when wired up.
//   3. Return a small `details` payload that gets stored alongside the
//      completion marker; the UI doesn't depend on its shape today but having
//      it makes per-step debugging trivial.

export type StepContext = {
  supabase: ServiceClient;
  job: JobRow;
  source: SourceAudio;
  logger: PipelineLogger;
};

export type StepResult = {
  // Optional structured metadata to persist alongside the stage completion.
  details?: Record<string, unknown>;
};

export type StepHandler = (ctx: StepContext) => Promise<StepResult>;

async function transcribingStep({ source, logger }: StepContext): Promise<StepResult> {
  // Placeholder for the Groq transcription step. The real step will:
  //   - stream the signed URL into the Groq Whisper endpoint;
  //   - upsert transcript_segments using (lesson_id, segment_index) which is
  //     unique, so re-running is idempotent at the row level;
  //   - record the model + confidence in provider_metadata.
  logger.info("Transcription placeholder — would download audio and call Groq", {
    bytes: source.byteSize,
    durationMs: source.durationMs,
  });
  return { details: { placeholder: true, model: null } };
}

async function diarizingStep({ logger }: StepContext): Promise<StepResult> {
  // Placeholder for speaker diarization. The real step will assign speaker
  // labels to existing transcript_segments (so the update is idempotent — same
  // rows, same indexes, just `speaker` filled in).
  logger.info("Diarization placeholder — would label transcript_segments");
  return { details: { placeholder: true } };
}

async function extractingStep({ logger }: StepContext): Promise<StepResult> {
  // Placeholder for vocab/grammar/dialogue extraction. The real step will
  // insert one extraction_runs row per kind and upsert cards keyed on
  // (lesson_id, deterministic content hash) to keep retries safe.
  logger.info("Extraction placeholder — would call the LLM and write extraction_runs");
  return { details: { placeholder: true } };
}

async function generatingAudioStep({ logger }: StepContext): Promise<StepResult> {
  // Placeholder for review-clip generation via Google TTS. The real step will
  // write clip objects to the lesson-clips bucket at a deterministic path
  // (`{householdId}/{lessonId}/clips/{cardId}.mp3`) so a re-run overwrites
  // rather than duplicating.
  logger.info("Audio generation placeholder — would synthesise per-card review clips");
  return { details: { placeholder: true } };
}

export type StepHandlerMap = Record<WorkerStage, StepHandler>;

export const STEPS: StepHandlerMap = {
  transcribing: transcribingStep,
  diarizing: diarizingStep,
  extracting: extractingStep,
  generating_audio: generatingAudioStep,
};

// Drives a single stage end-to-end. Skips when the stage is already marked
// complete in provider_metadata so retries pick up exactly where the previous
// attempt died. Accepts an explicit map so tests can inject step handlers
// without monkey-patching the module-level `STEPS` constant.
export async function runStage(
  ctx: StepContext,
  stage: WorkerStage,
  steps: StepHandlerMap = STEPS,
): Promise<JobRow> {
  if (isStageCompleted(ctx.job.provider_metadata, stage)) {
    ctx.logger.info(`Skipping ${stage} — already completed on a prior attempt`);
    return ctx.job;
  }
  const handler = steps[stage];
  const result = await handler(ctx);
  return markStageCompleted(ctx.supabase, ctx.job, stage, result.details);
}

export { WORKER_STAGES };
