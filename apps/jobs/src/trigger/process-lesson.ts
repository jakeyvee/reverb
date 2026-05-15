import { logger, task } from "@trigger.dev/sdk/v3";
import { runLessonPipeline } from "../lesson-pipeline/orchestrator.js";
import { createWorkerClient } from "../lesson-pipeline/state.js";

// `processLessonTask` is the single entrypoint for the lesson processing
// pipeline. The web app enqueues one run per upload using
// `lessonProcessingIdempotencyKey(lessonId)` so Trigger.dev coalesces duplicate
// dispatches, and the task itself walks the lesson_jobs row through every
// stage (transcribing → diarizing → extracting → generating_audio → ready).
//
// Recovery model:
//   * Trigger.dev retries the whole `run` body on a thrown error (see
//     `trigger.config.ts` for the retry policy). Each step short-circuits
//     when its stage is already marked complete in `provider_metadata.stages`,
//     so a retry resumes from the failed stage rather than redoing work.
//   * If the run finally exhausts retries we persist `status='failed'` with
//     a user-facing `error_summary`. A subsequent manual re-dispatch (or a
//     "retry" UI in a later issue) can re-enqueue with the same idempotency
//     key; the task will see the partial completion markers and pick up.
//
// The orchestration itself lives in `lesson-pipeline/orchestrator.ts` so it
// can be unit-tested without a Trigger.dev runtime.
export const processLessonTask = task({
  id: "process-lesson",
  // Cover a 90-minute lesson plus headroom for each provider step.
  maxDuration: 60 * 30,
  run: async (payloadInput: unknown, { ctx }) => {
    return runLessonPipeline({
      supabase: createWorkerClient(),
      payload: payloadInput,
      triggerRunId: ctx.run.id,
      logger,
    });
  },
});
