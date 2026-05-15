import {
  advanceStatus,
  completeRun,
  failRun,
  loadJobByLesson,
  loadSourceAudio,
  startRun,
  type JobRow,
  type ServiceClient,
} from "./state.js";
import { runStage } from "./steps.js";
import type { PipelineLogger } from "./logger.js";
import { defaultPipelineServices, type PipelineServices } from "./services.js";
import {
  ProcessLessonPayloadSchema,
  WORKER_STAGES,
  type ProcessLessonPayload,
  type WorkerStage,
} from "./types.js";

export type RunPipelineInput = {
  supabase: ServiceClient;
  payload: ProcessLessonPayload | unknown;
  triggerRunId: string | null;
  logger: PipelineLogger;
  // Optional override of the provider adapters (Groq Whisper, etc.). Production
  // code can leave this unset and pick up the real defaults; tests inject stubs
  // so the orchestrator can be exercised without external network calls.
  services?: PipelineServices;
};

export type RunPipelineResult =
  | { lessonId: string; jobId: string; status: "ready"; skipped: boolean }
  | never;

// Pure orchestrator: walks the lesson_jobs row through every stage and
// finalises it. Lives in its own module — no Trigger.dev imports — so unit
// tests can exercise the resume-on-failure behaviour without booting a worker.
export async function runLessonPipeline(input: RunPipelineInput): Promise<RunPipelineResult> {
  const payload = ProcessLessonPayloadSchema.parse(input.payload);
  const { supabase, logger, triggerRunId } = input;
  const services = input.services ?? defaultPipelineServices();

  let job: JobRow = await loadJobByLesson(supabase, payload.lessonId);

  if (job.status === "ready") {
    // Idempotent re-entry: the row was already finalised on a prior run. We
    // skip without bumping attempt_count so the metric stays honest.
    logger.info("Lesson already processed; nothing to do", { lessonId: payload.lessonId });
    return {
      lessonId: payload.lessonId,
      jobId: job.id,
      status: "ready",
      skipped: true,
    };
  }

  job = await startRun(supabase, job, triggerRunId);
  logger.info("Starting lesson pipeline", {
    lessonId: payload.lessonId,
    jobId: job.id,
    attempt: job.attempt_count,
    runId: triggerRunId,
  });

  // `currentStage` stays null until we successfully enter the first worker
  // stage, so a failure inside `loadSourceAudio` is recorded with stage=null
  // rather than mis-attributed to `transcribing`.
  let currentStage: WorkerStage | null = null;
  try {
    const source = await loadSourceAudio(supabase, payload.lessonId);
    for (const stage of WORKER_STAGES) {
      currentStage = stage;
      job = await advanceStatus(supabase, job, stage);
      logger.info(`Entering stage: ${stage}`, { lessonId: payload.lessonId, jobId: job.id });
      job = await runStage({ supabase, job, source, services, logger }, stage);
    }
    job = await advanceStatus(supabase, job, "ready");
    job = await completeRun(supabase, job);
  } catch (err) {
    const summary = describeError(err);
    logger.error(`Stage ${currentStage ?? "load_source"} failed`, {
      lessonId: payload.lessonId,
      jobId: job.id,
      stage: currentStage,
      message: summary,
    });
    await failRun(supabase, job, currentStage, summary);
    // Re-throw so Trigger.dev marks the run failed and applies the configured
    // retry policy. The stage is already recorded on the row, so the next
    // attempt resumes from `currentStage`.
    throw err;
  }

  logger.info("Lesson pipeline complete", { lessonId: payload.lessonId, jobId: job.id });
  return {
    lessonId: payload.lessonId,
    jobId: job.id,
    status: "ready",
    skipped: false,
  };
}

export function describeError(err: unknown): string {
  if (err instanceof Error) {
    // Trim long stack traces — the worker log keeps the full stack. The
    // `error_summary` column is what the user sees on the failed-lesson card.
    return err.message.length > 240 ? `${err.message.slice(0, 237)}…` : err.message;
  }
  return typeof err === "string" ? err : "Unknown processing error";
}
