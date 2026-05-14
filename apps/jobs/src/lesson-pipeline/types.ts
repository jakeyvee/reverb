import { z } from "zod";
import {
  LESSON_PROCESSING_STAGES,
  type LessonProcessingStage,
} from "@reverb/domain/schemas/lesson-status";

// Payload the web app sends when enqueuing the pipeline. Keep it minimal: the
// worker re-reads everything else from the database, so we never have to worry
// about a stale snapshot diverging from the lesson row.
export const ProcessLessonPayloadSchema = z.object({
  lessonId: z.string().uuid(),
});
export type ProcessLessonPayload = z.infer<typeof ProcessLessonPayloadSchema>;

// Per-stage idempotency markers persisted under `lesson_jobs.provider_metadata`.
// We never write to product tables (transcripts, cards, clips) from a
// placeholder step, so the marker is the only thing a retry needs to consult.
export type StageCompletion = { completed_at: string };
export type StageCompletionMap = Partial<Record<LessonProcessingStage, StageCompletion>>;

// The stages we actively run as worker steps. `queued` and `ready` bracket the
// pipeline and are managed by the orchestrator itself, not a step function.
export const WORKER_STAGES = LESSON_PROCESSING_STAGES.filter(
  (s) => s !== "queued" && s !== "ready",
) as Exclude<LessonProcessingStage, "queued" | "ready">[];

export type WorkerStage = (typeof WORKER_STAGES)[number];
