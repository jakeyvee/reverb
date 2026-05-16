import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { type Tables } from "@reverb/db/types";
import { SCHEMA_VERSIONS, type ExtractionOutput } from "@reverb/domain";
import { LESSON_AUDIO_BUCKET } from "@reverb/domain/schemas/upload";
import { runLessonPipeline } from "../../src/lesson-pipeline/orchestrator.js";
import { type PipelineServices } from "../../src/lesson-pipeline/services.js";
import { type ServiceClient } from "../../src/lesson-pipeline/state.js";
import { STEPS, type StepHandler, type StepHandlerMap } from "../../src/lesson-pipeline/steps.js";
import { noopLogger } from "../../src/lesson-pipeline/logger.js";
import { FakeSupabase } from "./fake-supabase.js";

// VOL-136 acceptance criteria coverage:
//
//   - Re-running extraction creates new versioned extraction_runs and marks
//     the prior versions superseded (not deleted).
//   - vocab_items survive across re-runs, so cards (and any FSRS history)
//     stay attached. (Already exercised in extracting.test.ts; this file
//     extends the assertion to cover the version bookkeeping.)
//   - teacher_corrections survive across re-runs via the natural-key upsert,
//     so correction_drills (per-user mistake-drill progress) is preserved.

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
    duration_ms: 3000,
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
    title: "Reprocess lesson",
    description: null,
    source_language: null,
    target_language: null,
    recorded_at: null,
    status: "processing",
    duration_ms: 3000,
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

function seed(supabase: FakeSupabase): void {
  supabase.insertJob(buildJob());
  supabase.insertFile(buildFile());
  supabase.insertLesson(buildLesson());
  supabase.insertProfile(buildProfile(USER_A));
  supabase.insertProfile(buildProfile(USER_B));
}

function asClient(supabase: FakeSupabase): ServiceClient {
  return supabase as unknown as ServiceClient;
}

function buildSteps(promptVersion: string): {
  steps: StepHandlerMap;
  services: PipelineServices;
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
          speaker_confidence: null,
          speaker_notes: null,
          speaker_low_priority: false,
          language: "id",
          text: "Saya mau kopi.",
          metadata: {},
          created_at: new Date().toISOString(),
        },
        {
          id: `seg-${job.lesson_id}-1`,
          lesson_id: job.lesson_id,
          segment_index: 1,
          start_ms: 1000,
          end_ms: 2000,
          speaker: null,
          speaker_confidence: null,
          speaker_notes: null,
          speaker_low_priority: false,
          language: "id",
          text: "saya mau kopi juga.",
          metadata: {},
          created_at: new Date().toISOString(),
        },
      ],
      { onConflict: "lesson_id,segment_index", ignoreDuplicates: false },
    );
    return { details: { segments: 2 } };
  };

  const diarizingStep: StepHandler = async ({ supabase, job }) => {
    await (supabase as unknown as FakeSupabase)
      .from("transcript_segments")
      .update({
        speaker: "student_vincent",
        speaker_confidence: 0.94,
        speaker_notes: null,
        speaker_low_priority: false,
      })
      .eq("id", `seg-${job.lesson_id}-0`);
    await (supabase as unknown as FakeSupabase)
      .from("transcript_segments")
      .update({
        speaker: "student_vincent",
        speaker_confidence: 0.9,
        speaker_notes: null,
        speaker_low_priority: false,
      })
      .eq("id", `seg-${job.lesson_id}-1`);
    return { details: { labels: 2 } };
  };

  const extraction: ExtractionOutput = {
    schemaVersion: SCHEMA_VERSIONS.extractionOutput,
    promptVersion,
    language: "id",
    sourceTranscriptId: LESSON_ID,
    new_vocab: [
      {
        term: "kopi",
        language: "id",
        pronunciation: "kopi",
        partOfSpeech: "noun",
        gloss: "coffee",
        example: "Saya mau kopi.",
        exampleGloss: "I want coffee.",
        sourceSegmentIds: ["S0"],
        difficulty: "beginner",
      },
    ],
    grammar_patterns: [],
    dialogue_clips: [],
    teacher_corrections: [
      {
        studentSpeaker: "student_vincent",
        segmentId: "S1",
        utterance: "saya mau kopi juga.",
        correction: "Saya mau kopi juga.",
        rationale: "Capitalize the sentence start.",
        category: "grammar",
        severity: "minor",
      },
    ],
  };

  const services: PipelineServices = {
    transcribe: async () => {
      throw new Error("not used in reprocess tests");
    },
    diarize: async () => {
      throw new Error("not used in reprocess tests");
    },
    extract: async () => ({
      extraction,
      rawResponse: JSON.stringify(extraction),
      model: `model-${promptVersion}`,
      promptVersion,
    }),
    generateGrammarExercises: async (input) => ({
      output: {
        schemaVersion: SCHEMA_VERSIONS.grammarExercise,
        promptVersion: `grammar-ex-${promptVersion}`,
        patternId: input.patternId,
        language: input.language,
        exercises: Array.from({ length: 5 }, () => ({
          kind: "fill_blank" as const,
          prompt: "Saya ___ kopi.",
          answer: "mau",
          acceptedAnswers: ["mau"],
          explanation: "`mau` expresses desire.",
        })),
      },
      rawResponse: "{}",
      model: `grammar-model-${promptVersion}`,
      promptVersion: `grammar-ex-${promptVersion}`,
    }),
    synthesize: async (input) => Buffer.from(`audio:${input.text}`, "utf8"),
    emailer: {
      sendReady: async () => ({ ok: true, messageId: "msg" }),
      sendFailed: async () => ({ ok: true, messageId: "msg" }),
    },
    resolveRecipientEmail: async (userId) => `${userId}@example.test`,
    resolveVincentEmail: () => "vincent@example.test",
  };

  return {
    steps: {
      ...STEPS,
      transcribing: transcribingStep,
      diarizing: diarizingStep,
    },
    services,
  };
}

describe("runLessonPipeline reprocess", () => {
  it("re-running extraction bumps version and marks prior runs superseded", async () => {
    const supabase = new FakeSupabase();
    seed(supabase);

    const first = buildSteps("extract-v1");
    await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_1",
      logger: noopLogger,
      steps: first.steps,
      services: first.services,
    });

    // First pass writes one row per kind (vocab/grammar/dialogue/corrections)
    // at version 1, all non-superseded.
    expect(supabase.extractionRuns).toHaveLength(4);
    for (const run of supabase.extractionRuns) {
      expect(run.version).toBe(1);
      expect(run.superseded_at).toBeNull();
      expect(run.prompt_version).toBe("extract-v1");
    }

    // Simulate the reprocess action: clear extracting + generating_audio
    // markers, flip status back to processing, leave the audio + diarization
    // stages intact. The orchestrator does the rest.
    const job = supabase.job();
    job.status = "ready";
    const meta = (job.provider_metadata ?? {}) as {
      stages?: Record<string, unknown>;
    };
    if (meta.stages) {
      delete meta.stages.extracting;
      delete meta.stages.generating_audio;
    }
    job.provider_metadata = meta;
    // Worker code reads status to decide whether to short-circuit; flip to
    // `extracting` to mirror what the server action does. The orchestrator
    // doesn't gate on this for non-ready/failed statuses, so we also nudge
    // it past the ready short-circuit.
    job.status = "extracting";
    job.finished_at = null;

    const second = buildSteps("extract-v2");
    await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_2",
      logger: noopLogger,
      steps: second.steps,
      services: second.services,
    });

    // After reprocess: 8 total extraction_runs rows. The original 4 are
    // marked superseded; the 4 fresh ones are version 2 with the new
    // prompt_version tag.
    expect(supabase.extractionRuns).toHaveLength(8);
    const v1 = supabase.extractionRuns.filter((r) => r.version === 1);
    const v2 = supabase.extractionRuns.filter((r) => r.version === 2);
    expect(v1).toHaveLength(4);
    expect(v2).toHaveLength(4);
    for (const run of v1) {
      expect(run.superseded_at).not.toBeNull();
      expect(run.prompt_version).toBe("extract-v1");
    }
    for (const run of v2) {
      expect(run.superseded_at).toBeNull();
      expect(run.prompt_version).toBe("extract-v2");
    }
  });

  it("re-running extraction preserves vocab_items and the cards that hang off them", async () => {
    const supabase = new FakeSupabase();
    seed(supabase);

    const first = buildSteps("extract-v1");
    await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_1",
      logger: noopLogger,
      steps: first.steps,
      services: first.services,
    });

    const vocabIdsBefore = supabase.vocabItems.map((row) => row.id).sort();
    const cardIdsBefore = supabase.cards.map((row) => row.id).sort();
    expect(vocabIdsBefore).toHaveLength(1);
    expect(cardIdsBefore).toHaveLength(2);

    // Simulate per-user FSRS progress: bump the card metadata so we can tell
    // the row is the same object after the reprocess (the upsert
    // ignoreDuplicates path leaves the existing row's columns alone).
    for (const card of supabase.cards) {
      card.state = "review";
      card.reps = 4;
    }

    // Reset job state for reprocess.
    const job = supabase.job();
    const meta = (job.provider_metadata ?? {}) as {
      stages?: Record<string, unknown>;
    };
    if (meta.stages) {
      delete meta.stages.extracting;
      delete meta.stages.generating_audio;
    }
    job.provider_metadata = meta;
    job.status = "extracting";
    job.finished_at = null;

    const second = buildSteps("extract-v2");
    await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_2",
      logger: noopLogger,
      steps: second.steps,
      services: second.services,
    });

    // Vocab + cards are identity-stable. The user's review state on the
    // existing card is untouched.
    expect(supabase.vocabItems.map((row) => row.id).sort()).toEqual(vocabIdsBefore);
    expect(supabase.cards.map((row) => row.id).sort()).toEqual(cardIdsBefore);
    for (const card of supabase.cards) {
      expect(card.state).toBe("review");
      expect(card.reps).toBe(4);
    }
  });

  it("re-running extraction preserves teacher_corrections identity, so correction_drills are not orphaned", async () => {
    const supabase = new FakeSupabase();
    seed(supabase);

    const first = buildSteps("extract-v1");
    await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_1",
      logger: noopLogger,
      steps: first.steps,
      services: first.services,
    });

    expect(supabase.teacherCorrections).toHaveLength(1);
    const correctionId = supabase.teacherCorrections[0]!.id;
    const lessonId = supabase.teacherCorrections[0]!.lesson_id;
    const kind = supabase.teacherCorrections[0]!.kind;
    const sourceText = supabase.teacherCorrections[0]!.source_text;
    const correctedText = supabase.teacherCorrections[0]!.corrected_text;

    // Reset job state for reprocess.
    const job = supabase.job();
    const meta = (job.provider_metadata ?? {}) as {
      stages?: Record<string, unknown>;
    };
    if (meta.stages) {
      delete meta.stages.extracting;
      delete meta.stages.generating_audio;
    }
    job.provider_metadata = meta;
    job.status = "extracting";
    job.finished_at = null;

    const second = buildSteps("extract-v2");
    await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_2",
      logger: noopLogger,
      steps: second.steps,
      services: second.services,
    });

    // Identity-stable: the row id (which correction_drills.teacher_correction_id
    // FK points at) is the same after the reprocess.
    expect(supabase.teacherCorrections).toHaveLength(1);
    const after = supabase.teacherCorrections[0]!;
    expect(after.id).toBe(correctionId);
    expect(after.lesson_id).toBe(lessonId);
    expect(after.kind).toBe(kind);
    expect(after.source_text).toBe(sourceText);
    expect(after.corrected_text).toBe(correctedText);
  });
});
