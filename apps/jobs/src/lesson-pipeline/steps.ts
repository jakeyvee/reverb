import { DIARIZATION_PROMPT_VERSION } from "@reverb/ai";
import type {
  DiarizationOutput,
  DiarizationSegmentLabel,
  SpeakerLabel,
  Transcript,
} from "@reverb/domain";
import type { JobRow, ServiceClient, SourceAudio } from "./state.js";
import { isStageCompleted, markStageCompleted } from "./state.js";
import type { PipelineLogger } from "./logger.js";
import type { PipelineServices } from "./services.js";
import { WORKER_STAGES, type WorkerStage } from "./types.js";

// Each stage handler is the seam where the real provider integration lives.
// For VOL-110 the transcribing stage is implemented end-to-end against Groq
// Whisper; later issues fill in the remaining placeholders.
//
// Contract every step must follow:
//   1. Short-circuit if `provider_metadata.stages.<stage>` is already set.
//   2. Writes to product tables (transcript_segments, transcript_words, etc.)
//      must be safely re-runnable — either upsert on a stable natural key, or
//      delete-then-insert keyed on `lesson_id` so a retry replaces the prior
//      attempt's output rather than duplicating it.
//   3. Return a small `details` payload that gets stored alongside the
//      completion marker; the UI doesn't depend on its shape today but having
//      it makes per-step debugging trivial.

export type StepContext = {
  supabase: ServiceClient;
  job: JobRow;
  source: SourceAudio;
  services: PipelineServices;
  logger: PipelineLogger;
};

export type StepResult = {
  // Optional structured metadata to persist alongside the stage completion.
  details?: Record<string, unknown>;
};

export type StepHandler = (ctx: StepContext) => Promise<StepResult>;

// MVP defaults to Bahasa Indonesia. The lessons row will eventually carry an
// explicit `source_language` and the worker should prefer that; until then the
// product targets Indonesian only.
const DEFAULT_LANGUAGE = "id";

async function transcribingStep(ctx: StepContext): Promise<StepResult> {
  const { supabase, source, services, logger, job } = ctx;
  const language = DEFAULT_LANGUAGE;
  logger.info("Calling Groq Whisper", {
    lessonId: job.lesson_id,
    bytes: source.byteSize,
    durationMs: source.durationMs,
    language,
  });

  const { transcript, rawResponse, model } = await services.transcribe({
    audioUrl: source.signedUrl,
    language,
    sourceId: job.lesson_id,
    fileName: defaultFileNameFromPath(source.storagePath),
  });

  const persisted = await persistTranscript(supabase, job.lesson_id, transcript);
  logger.info("Persisted transcript", {
    lessonId: job.lesson_id,
    segmentCount: persisted.segmentCount,
    wordCount: persisted.wordCount,
  });

  // Raw provider payload is kept on the job row's provider_metadata so we can
  // diff against a future re-run or debug a parse failure without re-fetching
  // the audio. The normalized rows in transcript_segments/transcript_words
  // remain the source of truth for app-facing reads.
  return {
    details: {
      provider: transcript.provider,
      model,
      language: transcript.language,
      duration_sec: transcript.durationSec,
      segment_count: persisted.segmentCount,
      word_count: persisted.wordCount,
      raw_response: rawResponse as unknown,
    },
  };
}

function defaultFileNameFromPath(storagePath: string): string {
  const segments = storagePath.split("/");
  return segments[segments.length - 1] ?? "lesson.audio";
}

export type PersistTranscriptResult = {
  segmentCount: number;
  wordCount: number;
};

// Replaces all transcript_segments / transcript_words rows for a lesson with
// the ones produced by `transcript`. The schema's cascade-on-delete from
// segments → words means a single delete cleans both tables; we then bulk-
// insert the new rows. The write is keyed on `lesson_id` so a retry of the
// same stage is idempotent at the table level even if the previous attempt
// got partway through.
export async function persistTranscript(
  supabase: ServiceClient,
  lessonId: string,
  transcript: Transcript,
): Promise<PersistTranscriptResult> {
  const { error: deleteError } = await supabase
    .from("transcript_segments")
    .delete()
    .eq("lesson_id", lessonId);
  if (deleteError) {
    throw new Error(
      `Could not clear transcript_segments for lesson ${lessonId}: ${deleteError.message}`,
    );
  }

  if (transcript.segments.length === 0) {
    return { segmentCount: 0, wordCount: 0 };
  }

  const segmentRows = transcript.segments.map((seg, idx) => ({
    lesson_id: lessonId,
    segment_index: idx,
    start_ms: toMs(seg.start),
    end_ms: toMs(seg.end),
    text: seg.text,
    speaker: null,
    language: seg.language ?? transcript.language,
    metadata: {
      provider_segment_id: seg.id,
      ...(typeof seg.confidence === "number" ? { confidence: seg.confidence } : {}),
    },
  }));

  const { data: insertedSegments, error: insertError } = await supabase
    .from("transcript_segments")
    .insert(segmentRows)
    .select("id, segment_index");
  if (insertError || !insertedSegments) {
    throw new Error(
      `Could not insert transcript_segments for lesson ${lessonId}: ${insertError?.message ?? "no rows returned"}`,
    );
  }

  const segmentIdByIndex = new Map<number, string>();
  for (const row of insertedSegments) {
    segmentIdByIndex.set(row.segment_index, row.id);
  }

  const wordRows = transcript.segments.flatMap((seg, segIdx) => {
    const segmentId = segmentIdByIndex.get(segIdx);
    if (!segmentId || !seg.words) return [];
    return seg.words.map((word, wordIdx) => ({
      segment_id: segmentId,
      lesson_id: lessonId,
      word_index: wordIdx,
      start_ms: toMs(word.start),
      end_ms: toMs(word.end),
      text: word.word,
      confidence: typeof word.confidence === "number" ? word.confidence : null,
    }));
  });

  if (wordRows.length > 0) {
    const { error: wordsError } = await supabase.from("transcript_words").insert(wordRows);
    if (wordsError) {
      throw new Error(
        `Could not insert transcript_words for lesson ${lessonId}: ${wordsError.message}`,
      );
    }
  }

  return { segmentCount: segmentRows.length, wordCount: wordRows.length };
}

function toMs(sec: number): number {
  return Math.round(sec * 1000);
}

async function diarizingStep(ctx: StepContext): Promise<StepResult> {
  const { supabase, services, logger, job } = ctx;

  const segments = await loadSegmentsForDiarization(supabase, job.lesson_id);
  if (segments.length === 0) {
    logger.info("Diarization skipped — no transcript segments to label", {
      lessonId: job.lesson_id,
    });
    return {
      details: {
        provider: "noop",
        prompt_version: DIARIZATION_PROMPT_VERSION,
        segment_count: 0,
        labeled_count: 0,
        unknown_count: 0,
        low_priority_count: 0,
      },
    };
  }

  // We send the LLM a stable index-based id (S0, S1, …) and map back to the
  // database UUID locally. The prompt never sees row uuids, which keeps the
  // log payload short and the tokens cheap.
  const idByPromptId = new Map<string, string>();
  const inputSegments = segments.map((seg) => {
    const promptId = `S${seg.segment_index}`;
    idByPromptId.set(promptId, seg.id);
    return {
      id: promptId,
      text: seg.text,
      startSec: seg.start_ms / 1000,
      endSec: seg.end_ms / 1000,
      ...(seg.language ? { language: seg.language } : {}),
    };
  });

  const language = pickInputLanguage(segments);

  logger.info("Calling Anthropic diarization", {
    lessonId: job.lesson_id,
    segmentCount: inputSegments.length,
    language,
  });

  const { diarization, model, promptVersion, rawResponse } = await services.diarize({
    sourceTranscriptId: job.lesson_id,
    language,
    segments: inputSegments,
  });

  const labelByDbId = mapLabelsToSegmentIds(diarization, idByPromptId);
  const persistResult = await persistDiarizationLabels(supabase, segments, labelByDbId);

  logger.info("Persisted diarization labels", {
    lessonId: job.lesson_id,
    labeled: persistResult.labeledCount,
    unknown: persistResult.unknownCount,
    lowPriority: persistResult.lowPriorityCount,
    missing: persistResult.missingCount,
  });

  return {
    details: {
      provider: "anthropic-diarization",
      model,
      prompt_version: promptVersion,
      schema_version: diarization.schemaVersion,
      segment_count: segments.length,
      labeled_count: persistResult.labeledCount,
      unknown_count: persistResult.unknownCount,
      low_priority_count: persistResult.lowPriorityCount,
      // Segments the LLM did not return — we leave their speaker as null so
      // the UI / extraction can tell apart "didn't know yet" from "labeled
      // unknown deliberately". Captured here for audit.
      missing_count: persistResult.missingCount,
      raw_response: rawResponse,
    },
  };
}

type SegmentForDiarization = {
  id: string;
  segment_index: number;
  text: string;
  start_ms: number;
  end_ms: number;
  language: string | null;
};

async function loadSegmentsForDiarization(
  supabase: ServiceClient,
  lessonId: string,
): Promise<SegmentForDiarization[]> {
  const { data, error } = await supabase
    .from("transcript_segments")
    .select("id, segment_index, text, start_ms, end_ms, language")
    .eq("lesson_id", lessonId)
    .order("segment_index", { ascending: true });
  if (error) {
    throw new Error(`Could not load transcript_segments for diarization: ${error.message}`);
  }
  return (data ?? []) as SegmentForDiarization[];
}

function pickInputLanguage(segments: SegmentForDiarization[]): string {
  // Pick the first non-null language hint we have. Whisper sets the same
  // language on every segment so there is no need to vote — but defensively
  // fall back to the pipeline default when the field is empty.
  for (const seg of segments) {
    if (seg.language) return seg.language;
  }
  return DEFAULT_LANGUAGE;
}

// Match each LLM-emitted label back to its database row. Labels for prompt
// ids we never sent (the model hallucinated an id) are dropped with a logged
// warning by the caller — they cannot affect persistence because they have
// no matching row.
function mapLabelsToSegmentIds(
  output: DiarizationOutput,
  idByPromptId: Map<string, string>,
): Map<string, DiarizationSegmentLabel> {
  const result = new Map<string, DiarizationSegmentLabel>();
  for (const label of output.segments) {
    const dbId = idByPromptId.get(label.segmentId);
    if (!dbId) continue;
    result.set(dbId, label);
  }
  return result;
}

export type PersistDiarizationResult = {
  labeledCount: number;
  unknownCount: number;
  lowPriorityCount: number;
  /** Segments the LLM did not return a label for; left as speaker=null. */
  missingCount: number;
};

// Update each transcript_segments row in place: speaker, confidence, notes,
// low_priority. The original ASR text is never touched — diarization is a
// labeling pass, not a rewrite. Segments missing from the LLM response are
// left untouched (speaker stays null) so a partial response cannot blank out
// labels from a successful prior attempt.
export async function persistDiarizationLabels(
  supabase: ServiceClient,
  segments: SegmentForDiarization[],
  labelByDbId: Map<string, DiarizationSegmentLabel>,
): Promise<PersistDiarizationResult> {
  let labeled = 0;
  let unknown = 0;
  let lowPriority = 0;
  let missing = 0;

  for (const seg of segments) {
    const label = labelByDbId.get(seg.id);
    if (!label) {
      missing += 1;
      continue;
    }

    const speaker = label.speaker satisfies SpeakerLabel;
    if (speaker === "unknown") unknown += 1;
    if (label.lowPriority) lowPriority += 1;
    labeled += 1;

    const { error } = await supabase
      .from("transcript_segments")
      .update({
        speaker,
        speaker_confidence: label.confidence,
        speaker_notes: label.notes ?? null,
        speaker_low_priority: label.lowPriority,
      })
      .eq("id", seg.id);
    if (error) {
      throw new Error(
        `Could not update transcript_segments.${seg.id} with diarization label: ${error.message}`,
      );
    }
  }

  return {
    labeledCount: labeled,
    unknownCount: unknown,
    lowPriorityCount: lowPriority,
    missingCount: missing,
  };
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

export const STEPS: Record<WorkerStage, StepHandler> = {
  transcribing: transcribingStep,
  diarizing: diarizingStep,
  extracting: extractingStep,
  generating_audio: generatingAudioStep,
};

// Drives a single stage end-to-end. Skips when the stage is already marked
// complete in provider_metadata so retries pick up exactly where the previous
// attempt died.
export async function runStage(ctx: StepContext, stage: WorkerStage): Promise<JobRow> {
  if (isStageCompleted(ctx.job.provider_metadata, stage)) {
    ctx.logger.info(`Skipping ${stage} — already completed on a prior attempt`);
    return ctx.job;
  }
  const handler = STEPS[stage];
  const result = await handler(ctx);
  return markStageCompleted(ctx.supabase, ctx.job, stage, result.details);
}

export { WORKER_STAGES };
