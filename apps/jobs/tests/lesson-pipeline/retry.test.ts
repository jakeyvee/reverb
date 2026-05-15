import { describe, expect, it } from "vitest";
import type { Tables } from "@reverb/db/types";
import { LESSON_AUDIO_BUCKET } from "@reverb/domain/schemas/upload";
import { runLessonPipeline } from "../../src/lesson-pipeline/orchestrator.js";
import { type ServiceClient } from "../../src/lesson-pipeline/state.js";
import { type StepHandlerMap, type StepHandler } from "../../src/lesson-pipeline/steps.js";
import { type WorkerStage } from "../../src/lesson-pipeline/types.js";
import { noopLogger } from "../../src/lesson-pipeline/logger.js";
import { FakeSupabase } from "./fake-supabase.js";

const LESSON_ID = "11111111-2222-3333-4444-555555555555";
const HOUSEHOLD_ID = "household-1";
const USER_A = "user-a";
const USER_B = "user-b";

function buildJob(overrides: Partial<Tables<"lesson_jobs">> = {}): Tables<"lesson_jobs"> {
  const now = new Date(0).toISOString();
  return {
    id: "job-1",
    lesson_id: LESSON_ID,
    status: "queued",
    idempotency_key: `process_lesson:${LESSON_ID}`,
    attempt_count: 0,
    trigger_run_id: null,
    provider_metadata: {},
    payload: {},
    error_summary: null,
    queued_at: now,
    started_at: null,
    finished_at: null,
    failed_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function buildFile(): Tables<"lesson_files"> {
  return {
    id: "file-1",
    lesson_id: LESSON_ID,
    kind: "audio_source",
    storage_bucket: LESSON_AUDIO_BUCKET,
    storage_path: `${HOUSEHOLD_ID}/${LESSON_ID}/source.mp3`,
    mime_type: "audio/mpeg",
    byte_size: 1024,
    duration_ms: 60_000,
    checksum: null,
    metadata: {},
    created_at: new Date(0).toISOString(),
  };
}

function buildLesson(): Tables<"lessons"> {
  const now = new Date(0).toISOString();
  return {
    id: LESSON_ID,
    household_id: HOUSEHOLD_ID,
    title: "Test lesson",
    description: null,
    source_language: null,
    target_language: null,
    recorded_at: null,
    status: "processing",
    duration_ms: 60_000,
    metadata: {},
    created_by: USER_A,
    created_at: now,
    updated_at: now,
  };
}

function buildProfile(id: string): Tables<"profiles"> {
  const now = new Date(0).toISOString();
  return {
    id,
    household_id: HOUSEHOLD_ID,
    display_name: id,
    avatar_url: null,
    locale: null,
    timezone: "UTC",
    reminder_enabled: true,
    reminder_time: "08:00:00",
    onboarded_at: now,
    created_at: now,
    updated_at: now,
  };
}

function seed(supabase: FakeSupabase, jobOverrides: Partial<Tables<"lesson_jobs">> = {}) {
  supabase.insertJob(buildJob(jobOverrides));
  supabase.insertFile(buildFile());
  supabase.insertLesson(buildLesson());
  supabase.insertProfile(buildProfile(USER_A));
  supabase.insertProfile(buildProfile(USER_B));
}

function asClient(supabase: FakeSupabase): ServiceClient {
  return supabase as unknown as ServiceClient;
}

// Step handlers that simulate the real pipeline's side effects against
// derived tables. `transcribing` upserts on (lesson_id, segment_index) and
// `extracting` appends a fresh extraction_runs row. The orchestrator's
// `STAGE_RESET_HOOKS` is responsible for keeping extraction idempotent on
// retry — we assert that here by checking row counts after the second pass.
function buildSteps(opts: { failExtractingOnce?: boolean } = {}): {
  steps: StepHandlerMap;
  shouldFail: { value: boolean };
} {
  const shouldFail = { value: opts.failExtractingOnce ?? false };

  const transcribingStep: StepHandler = async ({ supabase, job }) => {
    // Upsert one transcript_segment keyed on (lesson_id, segment_index).
    await (supabase as unknown as FakeSupabase).from("transcript_segments").upsert(
      [
        {
          id: `seg-${job.lesson_id}-0`,
          lesson_id: job.lesson_id,
          segment_index: 0,
          start_ms: 0,
          end_ms: 1000,
          speaker: null,
          language: null,
          text: "hello world",
          metadata: {},
          created_at: new Date().toISOString(),
        },
      ],
      { onConflict: "lesson_id,segment_index", ignoreDuplicates: false },
    );
    return { details: { segments: 1 } };
  };

  const diarizingStep: StepHandler = async () => ({ details: { placeholder: true } });

  const extractingStep: StepHandler = async ({ supabase, job }) => {
    if (shouldFail.value) {
      // Toggle false so the next attempt succeeds.
      shouldFail.value = false;
      throw new Error("LLM provider timeout");
    }
    await (supabase as unknown as FakeSupabase).from("extraction_runs").insert({
      id: `run-${Math.random().toString(36).slice(2, 8)}`,
      lesson_id: job.lesson_id,
      kind: "vocab",
      status: "succeeded",
      model: "test-model",
      prompt_version: "v1",
      input: {},
      output: {},
      error: null,
      cost_cents: null,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    return { details: { run_kind: "vocab" } };
  };

  const generatingAudioStep: StepHandler = async () => ({ details: { placeholder: true } });

  return {
    steps: {
      transcribing: transcribingStep,
      diarizing: diarizingStep,
      extracting: extractingStep,
      generating_audio: generatingAudioStep,
    },
    shouldFail,
  };
}

describe("runLessonPipeline retry integration", () => {
  it("first run fails inside extracting, emits one lesson_failed notification per recipient", async () => {
    const supabase = new FakeSupabase();
    seed(supabase);
    const { steps } = buildSteps({ failExtractingOnce: true });

    await expect(
      runLessonPipeline({
        supabase: asClient(supabase),
        payload: { lessonId: LESSON_ID },
        triggerRunId: "run_1",
        logger: noopLogger,
        steps,
      }),
    ).rejects.toThrow(/LLM provider timeout/);

    const job = supabase.job();
    expect(job.status).toBe("failed");
    expect(job.attempt_count).toBe(1);

    // Two household members → two lesson_failed rows. Channel and stage are
    // recorded on each row so the inbox can render them as in-app updates.
    const failedNotifs = supabase.notifications.filter((n) => n.kind === "lesson_failed");
    expect(failedNotifs).toHaveLength(2);
    expect(failedNotifs.map((n) => n.user_id).sort()).toEqual([USER_A, USER_B].sort());
    for (const n of failedNotifs) {
      expect(n.channel).toBe("in_app");
      expect(n.lesson_id).toBe(LESSON_ID);
      const payload = n.payload as Record<string, unknown>;
      expect(payload.stage).toBe("extracting");
      expect(payload.error_summary).toBe("LLM provider timeout");
    }

    // Transcribing wrote one segment; the failure happened in extracting so
    // there are no extraction_runs yet.
    expect(supabase.transcriptSegments).toHaveLength(1);
    expect(supabase.extractionRuns).toHaveLength(0);

    // No lesson_ready notifications until the retry succeeds.
    expect(supabase.notifications.filter((n) => n.kind === "lesson_ready")).toHaveLength(0);
  });

  it("retry resumes from the failed stage, replaces extraction rows, and does not duplicate notifications", async () => {
    const supabase = new FakeSupabase();
    seed(supabase);
    const { steps } = buildSteps({ failExtractingOnce: true });

    // First attempt fails inside extracting.
    await expect(
      runLessonPipeline({
        supabase: asClient(supabase),
        payload: { lessonId: LESSON_ID },
        triggerRunId: "run_1",
        logger: noopLogger,
        steps,
      }),
    ).rejects.toThrow();

    const segmentsAfterFailure = supabase.transcriptSegments.length;
    const failedNotifsAfterFirst = supabase.notifications.filter(
      (n) => n.kind === "lesson_failed",
    ).length;
    expect(failedNotifsAfterFirst).toBe(2);

    // Second attempt: re-run with the same steps map (shouldFail is now
    // false). This simulates Vincent clicking "Retry" and the worker
    // picking up the row.
    const result = await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_2",
      logger: noopLogger,
      steps,
    });
    expect(result.status).toBe("ready");
    expect(result.skipped).toBe(false);

    const job = supabase.job();
    expect(job.status).toBe("ready");
    expect(job.attempt_count).toBe(2);
    expect(job.failed_at).toBeNull();
    expect(job.error_summary).toBeNull();

    // transcript_segments were upserted on (lesson_id, segment_index) so the
    // count did not double across attempts.
    expect(supabase.transcriptSegments).toHaveLength(segmentsAfterFailure);

    // extraction_runs: the retry's reset hook wiped the failed-stage table,
    // then the successful step inserted exactly one row. The previous (zero)
    // run is gone; the successful run is not appended on top of a stale row.
    expect(supabase.extractionRuns).toHaveLength(1);

    // Notifications dedupe per (user_id, lesson_id, kind). Each user has one
    // failed and one ready row after the retry succeeds.
    const failedAfterRetry = supabase.notifications.filter((n) => n.kind === "lesson_failed");
    const readyAfterRetry = supabase.notifications.filter((n) => n.kind === "lesson_ready");
    expect(failedAfterRetry).toHaveLength(2);
    expect(readyAfterRetry).toHaveLength(2);
    for (const n of readyAfterRetry) {
      expect(n.channel).toBe("in_app");
      expect(n.lesson_id).toBe(LESSON_ID);
    }
  });

  it("re-entering an already-ready job is a no-op and does not emit extra notifications", async () => {
    const supabase = new FakeSupabase();
    seed(supabase);
    const { steps } = buildSteps();

    await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_a",
      logger: noopLogger,
      steps,
    });

    const readyBefore = supabase.notifications.filter((n) => n.kind === "lesson_ready").length;
    const extractionsBefore = supabase.extractionRuns.length;

    const second = await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_b",
      logger: noopLogger,
      steps,
    });
    expect(second.skipped).toBe(true);

    // Re-entry doesn't emit anything fresh and doesn't run a step that would
    // append derived rows.
    expect(supabase.notifications.filter((n) => n.kind === "lesson_ready")).toHaveLength(
      readyBefore,
    );
    expect(supabase.extractionRuns).toHaveLength(extractionsBefore);
  });

  it("stage completion markers are stage-scoped — retrying after extracting failure does not re-run transcribing", async () => {
    const supabase = new FakeSupabase();
    seed(supabase);
    const stageCalls: WorkerStage[] = [];

    const stepFactory = buildSteps({ failExtractingOnce: true });
    const trackedSteps: StepHandlerMap = Object.fromEntries(
      (Object.entries(stepFactory.steps) as Array<[WorkerStage, StepHandler]>).map(
        ([stage, handler]) => [
          stage,
          async (ctx) => {
            stageCalls.push(stage);
            return handler(ctx);
          },
        ],
      ),
    ) as StepHandlerMap;

    await expect(
      runLessonPipeline({
        supabase: asClient(supabase),
        payload: { lessonId: LESSON_ID },
        triggerRunId: "run_1",
        logger: noopLogger,
        steps: trackedSteps,
      }),
    ).rejects.toThrow();

    stageCalls.length = 0; // reset before retry

    await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_2",
      logger: noopLogger,
      steps: trackedSteps,
    });

    // Stages that already completed on the first attempt (transcribing,
    // diarizing) short-circuit on the retry. Only the previously-failed
    // stage and any later stages execute.
    expect(stageCalls).toEqual(["extracting", "generating_audio"]);
  });
});
