import { tasks } from "@trigger.dev/sdk/v3";
import { lessonProcessingIdempotencyKey } from "@reverb/domain/schemas/lesson-status";

export type EnqueueResult =
  | { ok: true; runId: string | null; skipped: false }
  | { ok: true; runId: null; skipped: true; reason: "not_configured" }
  | { ok: false; error: string };

// Wraps `tasks.trigger` so the upload server action can enqueue the pipeline
// without leaking Trigger.dev specifics into the action itself. Returns the
// run handle id on success, or a `skipped` result when Trigger.dev credentials
// aren't configured so local development without a Trigger.dev account still
// finishes the upload — the lesson_jobs row stays in `queued`, and a manual
// re-dispatch can pick it up once credentials are added.
export async function enqueueLessonProcessing(lessonId: string): Promise<EnqueueResult> {
  if (!process.env.TRIGGER_SECRET_KEY) {
    return { ok: true, runId: null, skipped: true, reason: "not_configured" };
  }
  try {
    const handle = await tasks.trigger(
      "process-lesson",
      { lessonId },
      {
        // Stable across attempts so duplicate dispatches (double-click,
        // server-action retries) coalesce into a single Trigger.dev run.
        idempotencyKey: lessonProcessingIdempotencyKey(lessonId),
        // Tag the run so it's easy to find in the Trigger.dev dashboard when
        // debugging a specific lesson.
        tags: [`lesson:${lessonId}`],
      },
    );
    return { ok: true, runId: handle.id, skipped: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not enqueue the processing job";
    return { ok: false, error: message };
  }
}
