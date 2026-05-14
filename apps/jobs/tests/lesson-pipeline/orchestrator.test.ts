import { describe, expect, it } from "vitest";
import type { Tables } from "@reverb/db/types";
import { LESSON_AUDIO_BUCKET } from "@reverb/domain/schemas/upload";
import { runLessonPipeline } from "../../src/lesson-pipeline/orchestrator.js";
import { getCompletedStages, type ServiceClient } from "../../src/lesson-pipeline/state.js";
import { WORKER_STAGES } from "../../src/lesson-pipeline/types.js";
import { noopLogger } from "../../src/lesson-pipeline/logger.js";
import { FakeSupabase } from "./fake-supabase.js";

const LESSON_ID = "11111111-2222-3333-4444-555555555555";
const HOUSEHOLD_ID = "household-1";

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

function seed(supabase: FakeSupabase, jobOverrides: Partial<Tables<"lesson_jobs">> = {}) {
  supabase.insertJob(buildJob(jobOverrides));
  supabase.insertFile(buildFile());
}

function asClient(supabase: FakeSupabase): ServiceClient {
  // The orchestrator only touches the subset of supabase-js this fake covers.
  return supabase as unknown as ServiceClient;
}

describe("runLessonPipeline", () => {
  it("walks every stage and finishes with status=ready", async () => {
    const supabase = new FakeSupabase();
    seed(supabase);

    const result = await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_abc",
      logger: noopLogger,
    });

    expect(result.status).toBe("ready");
    expect(result.skipped).toBe(false);
    const job = supabase.job();
    expect(job.status).toBe("ready");
    expect(job.attempt_count).toBe(1);
    expect(job.trigger_run_id).toBe("run_abc");
    expect(job.started_at).not.toBeNull();
    expect(job.finished_at).not.toBeNull();
    expect(job.failed_at).toBeNull();
    expect(job.error_summary).toBeNull();

    const completed = getCompletedStages(job.provider_metadata);
    for (const stage of WORKER_STAGES) {
      expect(completed[stage]?.completed_at).toBeTypeOf("string");
    }

    // A signed URL was requested for the source audio: the orchestration
    // pulls the storage handle even before the placeholder steps run, which
    // is the seam future steps need.
    expect(supabase.signedUrlRequests).toEqual([
      {
        bucket: LESSON_AUDIO_BUCKET,
        path: `${HOUSEHOLD_ID}/${LESSON_ID}/source.mp3`,
        ttl: 7200,
      },
    ]);
  });

  it("is a no-op when the job is already ready", async () => {
    const supabase = new FakeSupabase();
    seed(supabase, {
      status: "ready",
      attempt_count: 1,
      provider_metadata: {
        stages: Object.fromEntries(
          WORKER_STAGES.map((s) => [s, { completed_at: new Date(0).toISOString() }]),
        ),
      },
    });

    const result = await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_xyz",
      logger: noopLogger,
    });

    expect(result.skipped).toBe(true);
    const job = supabase.job();
    // attempt_count did not move — re-entry on a finished job is free.
    expect(job.attempt_count).toBe(1);
    // No signed URL is requested because the orchestrator short-circuits
    // before pulling the source audio handle.
    expect(supabase.signedUrlRequests).toEqual([]);
  });

  it("resumes a failed run from the failed stage and finishes successfully", async () => {
    // Arrange: the previous attempt got through transcribing+diarizing and
    // crashed inside extracting. The row is marked failed with the two
    // completed stages recorded in provider_metadata.
    const supabase = new FakeSupabase();
    const previouslyCompleted = {
      stages: {
        transcribing: { completed_at: new Date(1).toISOString() },
        diarizing: { completed_at: new Date(2).toISOString() },
      },
    };
    seed(supabase, {
      status: "failed",
      attempt_count: 1,
      started_at: new Date(0).toISOString(),
      failed_at: new Date(3).toISOString(),
      error_summary: "transient provider error",
      provider_metadata: previouslyCompleted,
    });

    const result = await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_retry",
      logger: noopLogger,
    });

    expect(result.status).toBe("ready");
    const job = supabase.job();
    expect(job.status).toBe("ready");
    // Attempt count bumps once per retry.
    expect(job.attempt_count).toBe(2);
    // Error markers were cleared on a clean run.
    expect(job.failed_at).toBeNull();
    expect(job.error_summary).toBeNull();

    const completed = getCompletedStages(job.provider_metadata);
    // The pre-existing stage markers were preserved and not overwritten.
    expect(completed.transcribing?.completed_at).toBe(
      previouslyCompleted.stages.transcribing.completed_at,
    );
    expect(completed.diarizing?.completed_at).toBe(
      previouslyCompleted.stages.diarizing.completed_at,
    );
    // The two outstanding stages got their fresh markers.
    expect(completed.extracting?.completed_at).toBeTypeOf("string");
    expect(completed.generating_audio?.completed_at).toBeTypeOf("string");
  });

  it("persists failure state and rethrows when a stage update crashes", async () => {
    const supabase = new FakeSupabase();
    seed(supabase);
    // Trigger the throw on the orchestrator's transition into `extracting`.
    supabase.failOnNextUpdate = { whenStatus: "extracting" };

    await expect(
      runLessonPipeline({
        supabase: asClient(supabase),
        payload: { lessonId: LESSON_ID },
        triggerRunId: "run_boom",
        logger: noopLogger,
      }),
    ).rejects.toThrow(/simulated provider failure/);

    const job = supabase.job();
    expect(job.status).toBe("failed");
    expect(job.failed_at).not.toBeNull();
    expect(job.error_summary).toBe("simulated provider failure");

    // Completed stages so far are preserved on the row.
    const completed = getCompletedStages(job.provider_metadata);
    expect(completed.transcribing?.completed_at).toBeTypeOf("string");
    expect(completed.diarizing?.completed_at).toBeTypeOf("string");
    expect(completed.extracting).toBeUndefined();

    // And the failure metadata records the stage that died, so the next
    // attempt can deep-link / display "stuck on extracting" if it wants to.
    const meta = (job.provider_metadata ?? {}) as { last_failure?: { stage?: string } };
    expect(meta.last_failure?.stage).toBe("extracting");
  });

  it("persists failure state when source audio cannot be loaded", async () => {
    // Arrange: the job row exists, but no audio_source file row was inserted
    // (e.g. the lesson_files row is missing or has the wrong bucket / the
    // signed URL call fails). The orchestrator previously threw here before
    // entering its try block, leaving the row queued forever.
    const supabase = new FakeSupabase();
    supabase.insertJob(buildJob());

    await expect(
      runLessonPipeline({
        supabase: asClient(supabase),
        payload: { lessonId: LESSON_ID },
        triggerRunId: "run_no_audio",
        logger: noopLogger,
      }),
    ).rejects.toThrow(/no audio_source row/);

    const job = supabase.job();
    expect(job.status).toBe("failed");
    expect(job.failed_at).not.toBeNull();
    expect(job.error_summary).toMatch(/no audio_source row/);
    // The failure is attributed to no specific worker stage — it happened
    // before the first stage transition.
    const meta = (job.provider_metadata ?? {}) as { last_failure?: { stage?: string | null } };
    expect(meta.last_failure?.stage ?? null).toBeNull();
  });

  it("rejects payloads that don't carry a uuid lessonId", async () => {
    const supabase = new FakeSupabase();
    await expect(
      runLessonPipeline({
        supabase: asClient(supabase),
        payload: { lessonId: "not-a-uuid" },
        triggerRunId: null,
        logger: noopLogger,
      }),
    ).rejects.toThrow();
  });
});
