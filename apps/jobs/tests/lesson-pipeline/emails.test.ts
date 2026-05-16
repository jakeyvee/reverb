import { describe, expect, it } from "vitest";
import type { Tables } from "@reverb/db/types";
import type {
  LessonEmailer,
  SendEmailResult,
  SendLessonFailedEmailInput,
  SendLessonReadyEmailInput,
} from "@reverb/email";
import { LESSON_AUDIO_BUCKET } from "@reverb/domain/schemas/upload";
import { runLessonPipeline } from "../../src/lesson-pipeline/orchestrator.js";
import { type ServiceClient } from "../../src/lesson-pipeline/state.js";
import { type StepHandlerMap, type StepHandler } from "../../src/lesson-pipeline/steps.js";
import type {
  EmailRecipientResolver,
  VincentEmailResolver,
} from "../../src/lesson-pipeline/notifications.js";
import { noopLogger } from "../../src/lesson-pipeline/logger.js";
import { FakeSupabase } from "./fake-supabase.js";

const LESSON_ID = "22222222-3333-4444-5555-666666666666";
const HOUSEHOLD_ID = "household-emails";
const VINCENT_ID = "user-vincent";
const PARTNER_ID = "user-partner";
const VINCENT_EMAIL = "vincent@example.com";
const PARTNER_EMAIL = "partner@example.com";

function buildJob(overrides: Partial<Tables<"lesson_jobs">> = {}): Tables<"lesson_jobs"> {
  const now = new Date(0).toISOString();
  return {
    id: "job-emails-1",
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
    id: "file-emails-1",
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
    title: "Ordering coffee in Bahasa",
    description: null,
    source_language: null,
    target_language: null,
    recorded_at: null,
    status: "processing",
    duration_ms: 60_000,
    metadata: {},
    created_by: VINCENT_ID,
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
  supabase.insertProfile(buildProfile(VINCENT_ID));
  supabase.insertProfile(buildProfile(PARTNER_ID));
}

function asClient(supabase: FakeSupabase): ServiceClient {
  return supabase as unknown as ServiceClient;
}

// Captures every email the pipeline tries to send so assertions can check
// recipients, subjects, counts, and idempotency keys.
type CapturedReady = SendLessonReadyEmailInput;
type CapturedFailed = SendLessonFailedEmailInput;

function buildCapturingEmailer(): {
  emailer: LessonEmailer;
  ready: CapturedReady[];
  failed: CapturedFailed[];
} {
  const ready: CapturedReady[] = [];
  const failed: CapturedFailed[] = [];
  const ok: SendEmailResult = { ok: true, messageId: "msg_test" };
  return {
    ready,
    failed,
    emailer: {
      sendReady: async (input) => {
        ready.push(input);
        return ok;
      },
      sendFailed: async (input) => {
        failed.push(input);
        return ok;
      },
    },
  };
}

function buildEmailResolvers(): {
  resolveRecipientEmail: EmailRecipientResolver;
  resolveVincentEmail: VincentEmailResolver;
} {
  const emailByUser = new Map<string, string>([
    [VINCENT_ID, VINCENT_EMAIL],
    [PARTNER_ID, PARTNER_EMAIL],
  ]);
  return {
    resolveRecipientEmail: async (userId) => emailByUser.get(userId) ?? null,
    resolveVincentEmail: () => VINCENT_EMAIL,
  };
}

// The retry tests already cover stage idempotency end-to-end. Here we only
// model the happy-path steps and the extracting-step failure path, since the
// email behaviour is what we're isolating.
function buildHappyPathSteps(): {
  steps: StepHandlerMap;
} {
  const transcribingStep: StepHandler = async ({ supabase, job }) => {
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

  const noopStep: StepHandler = async () => ({ details: {} });

  const extractingStep: StepHandler = async ({ supabase, job }) => {
    // Seed a few extracted rows so the counts in the ready email are non-zero.
    const fake = supabase as unknown as FakeSupabase;
    await fake.from("vocab_items").insert([
      { lesson_id: job.lesson_id, household_id: HOUSEHOLD_ID, lemma: "kopi", translation: "coffee" },
      { lesson_id: job.lesson_id, household_id: HOUSEHOLD_ID, lemma: "susu", translation: "milk" },
      { lesson_id: job.lesson_id, household_id: HOUSEHOLD_ID, lemma: "gula", translation: "sugar" },
    ]);
    await fake.from("grammar_patterns").insert([
      {
        lesson_id: job.lesson_id,
        household_id: HOUSEHOLD_ID,
        pattern: "saya mau X",
        description: "I want X",
        examples: [],
      },
    ]);
    await fake.from("dialogue_clips").insert([
      {
        lesson_id: job.lesson_id,
        household_id: HOUSEHOLD_ID,
        start_ms: 0,
        end_ms: 1000,
        storage_bucket: "lesson-clips",
        storage_path: `${HOUSEHOLD_ID}/${job.lesson_id}/clips/d1.mp3`,
      },
      {
        lesson_id: job.lesson_id,
        household_id: HOUSEHOLD_ID,
        start_ms: 1000,
        end_ms: 2000,
        storage_bucket: "lesson-clips",
        storage_path: `${HOUSEHOLD_ID}/${job.lesson_id}/clips/d2.mp3`,
      },
    ]);
    // No teacher corrections this lesson — the email should hide that bullet.
    return { details: {} };
  };

  return {
    steps: {
      transcribing: transcribingStep,
      diarizing: noopStep,
      extracting: extractingStep,
      generating_audio: noopStep,
    },
  };
}

function buildFailingSteps(): { steps: StepHandlerMap } {
  const failingStep: StepHandler = async () => {
    throw new Error("Anthropic returned 503");
  };
  const noopStep: StepHandler = async () => ({ details: {} });
  return {
    steps: {
      transcribing: noopStep,
      diarizing: noopStep,
      extracting: failingStep,
      generating_audio: noopStep,
    },
  };
}

describe("lesson email dispatch", () => {
  it("sends one lesson_ready email per household member with summary counts and a stable idempotency key", async () => {
    const supabase = new FakeSupabase();
    seed(supabase);
    const { steps } = buildHappyPathSteps();
    const { emailer, ready, failed } = buildCapturingEmailer();
    const { resolveRecipientEmail, resolveVincentEmail } = buildEmailResolvers();

    await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_ready",
      logger: noopLogger,
      steps,
      services: {
        transcribe: async () => {
          throw new Error("not used");
        },
        diarize: async () => {
          throw new Error("not used");
        },
        extract: async () => {
          throw new Error("not used");
        },
        emailer,
        resolveRecipientEmail,
        resolveVincentEmail,
      },
    });

    expect(failed).toHaveLength(0);
    expect(ready).toHaveLength(2);
    expect(ready.map((r) => r.to).sort()).toEqual([VINCENT_EMAIL, PARTNER_EMAIL].sort());

    for (const email of ready) {
      expect(email.lessonTitle).toBe("Ordering coffee in Bahasa");
      expect(email.lessonId).toBe(LESSON_ID);
      expect(email.counts).toEqual({
        newVocab: 3,
        grammarPatterns: 1,
        teacherCorrections: 0,
        dialogueClips: 2,
      });
      // Idempotency key must include the per-row notification id so a Resend
      // retry on the same row coalesces, but two recipients still get
      // distinct keys (and distinct emails).
      expect(email.idempotencyKey.startsWith("lesson_ready:")).toBe(true);
    }
    const keys = ready.map((r) => r.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
  });

  it("does not re-send lesson_ready emails when the orchestrator re-enters an already-ready job", async () => {
    const supabase = new FakeSupabase();
    seed(supabase);
    const { steps } = buildHappyPathSteps();
    const { emailer, ready } = buildCapturingEmailer();
    const { resolveRecipientEmail, resolveVincentEmail } = buildEmailResolvers();

    const services = {
      transcribe: async () => {
        throw new Error("not used");
      },
      diarize: async () => {
        throw new Error("not used");
      },
      extract: async () => {
        throw new Error("not used");
      },
      emailer,
      resolveRecipientEmail,
      resolveVincentEmail,
    } as const;

    await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_first",
      logger: noopLogger,
      steps,
      services,
    });
    expect(ready).toHaveLength(2);

    await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_second",
      logger: noopLogger,
      steps,
      services,
    });
    // Re-entry short-circuits at the top of the orchestrator; no extra ready
    // emails should be queued.
    expect(ready).toHaveLength(2);
  });

  it("sends a single lesson_failed email to Vincent only, regardless of household size", async () => {
    const supabase = new FakeSupabase();
    seed(supabase);
    const { steps } = buildFailingSteps();
    const { emailer, ready, failed } = buildCapturingEmailer();
    const { resolveRecipientEmail, resolveVincentEmail } = buildEmailResolvers();

    await expect(
      runLessonPipeline({
        supabase: asClient(supabase),
        payload: { lessonId: LESSON_ID },
        triggerRunId: "run_fail",
        logger: noopLogger,
        steps,
        services: {
          transcribe: async () => {
            throw new Error("not used");
          },
          diarize: async () => {
            throw new Error("not used");
          },
          extract: async () => {
            throw new Error("not used");
          },
          emailer,
          resolveRecipientEmail,
          resolveVincentEmail,
        },
      }),
    ).rejects.toThrow(/Anthropic returned 503/);

    expect(ready).toHaveLength(0);
    expect(failed).toHaveLength(1);
    const email = failed[0]!;
    expect(email.to).toBe(VINCENT_EMAIL);
    expect(email.lessonTitle).toBe("Ordering coffee in Bahasa");
    expect(email.errorSummary).toBe("Anthropic returned 503");
    expect(email.stage).toBe("extracting");
    expect(email.attempt).toBe(1);
    expect(email.idempotencyKey).toBe(`lesson_failed:${LESSON_ID}:1`);
  });

  it("treats Resend send failures as non-fatal: pipeline still completes successfully", async () => {
    const supabase = new FakeSupabase();
    seed(supabase);
    const { steps } = buildHappyPathSteps();
    const erroringEmailer: LessonEmailer = {
      sendReady: async () => ({ ok: false, error: "boom", status: 500 }),
      sendFailed: async () => ({ ok: false, error: "boom", status: 500 }),
    };
    const { resolveRecipientEmail, resolveVincentEmail } = buildEmailResolvers();

    const result = await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_email_err",
      logger: noopLogger,
      steps,
      services: {
        transcribe: async () => {
          throw new Error("not used");
        },
        diarize: async () => {
          throw new Error("not used");
        },
        extract: async () => {
          throw new Error("not used");
        },
        emailer: erroringEmailer,
        resolveRecipientEmail,
        resolveVincentEmail,
      },
    });

    expect(result.status).toBe("ready");
    // In-app notifications were still written for every household member —
    // the email failure didn't roll anything back.
    expect(supabase.notifications.filter((n) => n.kind === "lesson_ready")).toHaveLength(2);
  });

  it("skips lesson_failed email when VINCENT_UPLOAD_EMAIL is not configured", async () => {
    const supabase = new FakeSupabase();
    seed(supabase);
    const { steps } = buildFailingSteps();
    const { emailer, failed } = buildCapturingEmailer();
    const resolvers = buildEmailResolvers();

    await expect(
      runLessonPipeline({
        supabase: asClient(supabase),
        payload: { lessonId: LESSON_ID },
        triggerRunId: "run_no_vincent",
        logger: noopLogger,
        steps,
        services: {
          transcribe: async () => {
            throw new Error("not used");
          },
          diarize: async () => {
            throw new Error("not used");
          },
          extract: async () => {
            throw new Error("not used");
          },
          emailer,
          resolveRecipientEmail: resolvers.resolveRecipientEmail,
          resolveVincentEmail: () => null,
        },
      }),
    ).rejects.toThrow();

    expect(failed).toHaveLength(0);
    // In-app rows are still written even when Vincent's email is missing — the
    // partner still sees the failure in the app.
    expect(supabase.notifications.filter((n) => n.kind === "lesson_failed")).toHaveLength(2);
  });
});
