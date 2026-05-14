import { z } from "zod";

// Ordered list of every state a lesson processing job walks through. The order
// matters: the UI uses it to render the stage badge and a "step N of M" hint,
// and `LESSON_PROCESSING_STAGE_INDEX[status]` is what later worker code uses
// to detect monotonic forward progress when applying status updates.
export const LESSON_PROCESSING_STAGES = [
  "queued",
  "transcribing",
  "diarizing",
  "extracting",
  "generating_audio",
  "ready",
] as const;

export type LessonProcessingStage = (typeof LESSON_PROCESSING_STAGES)[number];

export const LESSON_PROCESSING_STATUSES = [...LESSON_PROCESSING_STAGES, "failed"] as const;

export type LessonProcessingStatus = (typeof LESSON_PROCESSING_STATUSES)[number];

export const LessonProcessingStatusSchema = z.enum(LESSON_PROCESSING_STATUSES);

const STAGE_INDEX_MAP = Object.fromEntries(
  LESSON_PROCESSING_STAGES.map((s, i) => [s, i]),
) as Record<LessonProcessingStage, number>;

export function lessonStageIndex(status: LessonProcessingStage): number {
  return STAGE_INDEX_MAP[status];
}

export function isTerminalLessonStatus(status: LessonProcessingStatus): boolean {
  return status === "ready" || status === "failed";
}

export function isActiveLessonStatus(status: LessonProcessingStatus): boolean {
  return !isTerminalLessonStatus(status);
}

const STATUS_LABELS: Record<LessonProcessingStatus, string> = {
  queued: "Queued",
  transcribing: "Transcribing",
  diarizing: "Identifying speakers",
  extracting: "Extracting vocab",
  generating_audio: "Generating audio",
  ready: "Ready",
  failed: "Failed",
};

export function lessonStatusLabel(status: LessonProcessingStatus): string {
  return STATUS_LABELS[status];
}

// Short hint shown alongside the badge while a job is in flight. Returns null
// for terminal states so callers can fall back to the error summary / CTAs.
const STAGE_HINTS: Record<LessonProcessingStage, string> = {
  queued: "Waiting for a worker to pick it up.",
  transcribing: "Turning the audio into text.",
  diarizing: "Splitting the recording by speaker.",
  extracting: "Pulling vocab, grammar, and corrections from the transcript.",
  generating_audio: "Synthesising review clips.",
  ready: "Cards are ready to practice.",
};

export function lessonStatusHint(status: LessonProcessingStatus): string | null {
  if (status === "failed") return null;
  return STAGE_HINTS[status];
}

// One-based "step N of M" presentation. Failed jobs return the index of the
// stage they were on when they died, or null if unknown.
export function lessonStageProgress(
  status: LessonProcessingStatus,
): { step: number; total: number } | null {
  if (status === "failed") return null;
  return {
    step: STAGE_INDEX_MAP[status] + 1,
    total: LESSON_PROCESSING_STAGES.length,
  };
}

// Deterministic idempotency key for the single pipeline job a lesson owns.
// Workers use this to coalesce duplicate dispatches; the web app sets it when
// the lesson_jobs row is first inserted at upload finalize.
export function lessonProcessingIdempotencyKey(lessonId: string): string {
  return `process_lesson:${lessonId}`;
}
