import { describe, expect, it } from "vitest";
import { type Tables } from "@reverb/db/types";
import type { InferExtractionInput } from "@reverb/ai";
import { SCHEMA_VERSIONS, type ExtractionOutput } from "@reverb/domain";
import { LESSON_AUDIO_BUCKET } from "@reverb/domain/schemas/upload";
import { runLessonPipeline } from "../../src/lesson-pipeline/orchestrator.js";
import { type PipelineServices } from "../../src/lesson-pipeline/services.js";
import { type ServiceClient } from "../../src/lesson-pipeline/state.js";
import { STEPS, type StepHandler, type StepHandlerMap } from "../../src/lesson-pipeline/steps.js";
import { noopLogger } from "../../src/lesson-pipeline/logger.js";
import { FakeSupabase } from "./fake-supabase.js";

const LESSON_ID = "11111111-2222-3333-4444-555555555555";
const HOUSEHOLD_ID = "household-1";
const USER_A = "user-a";
const USER_B = "user-b";

function buildJob(): Tables<"lesson_jobs"> {
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
    title: "Extraction lesson",
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

function seed(supabase: FakeSupabase) {
  supabase.insertJob(buildJob());
  supabase.insertFile(buildFile());
  supabase.insertLesson(buildLesson());
  supabase.insertProfile(buildProfile(USER_A));
  supabase.insertProfile(buildProfile(USER_B));
}

function asClient(supabase: FakeSupabase): ServiceClient {
  return supabase as unknown as ServiceClient;
}

function buildSteps(): {
  steps: StepHandlerMap;
  capturedExtractionInput: { value: InferExtractionInput | null };
  services: PipelineServices;
} {
  const capturedExtractionInput = { value: null as InferExtractionInput | null };

  const transcribingStep: StepHandler = async ({ supabase, job }) => {
    await (supabase as unknown as FakeSupabase).from("transcript_segments").insert([
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
        text: "Coffee is kopi.",
        metadata: {},
        created_at: new Date().toISOString(),
      },
      {
        id: `seg-${job.lesson_id}-2`,
        lesson_id: job.lesson_id,
        segment_index: 2,
        start_ms: 2000,
        end_ms: 3000,
        speaker: null,
        speaker_confidence: null,
        speaker_notes: null,
        speaker_low_priority: false,
        language: "id",
        text: "Saya mau kopi juga.",
        metadata: {},
        created_at: new Date().toISOString(),
      },
    ]);
    return { details: { segments: 3 } };
  };

  const diarizingStep: StepHandler = async ({ supabase, job }) => {
    await (supabase as unknown as FakeSupabase).from("transcript_segments").update({
      speaker: "student_vincent",
      speaker_confidence: 0.94,
      speaker_notes: null,
      speaker_low_priority: false,
    }).eq("id", `seg-${job.lesson_id}-0`);
    await (supabase as unknown as FakeSupabase).from("transcript_segments").update({
      speaker: "teacher",
      speaker_confidence: 0.88,
      speaker_notes: "English explanation",
      speaker_low_priority: true,
    }).eq("id", `seg-${job.lesson_id}-1`);
    await (supabase as unknown as FakeSupabase).from("transcript_segments").update({
      speaker: "student_gf",
      speaker_confidence: 0.9,
      speaker_notes: null,
      speaker_low_priority: false,
    }).eq("id", `seg-${job.lesson_id}-2`);
    return { details: { labels: 3 } };
  };

  const validExtraction: ExtractionOutput = {
    schemaVersion: SCHEMA_VERSIONS.extractionOutput,
    promptVersion: "extract-v1",
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
    grammar_patterns: [
      {
        pattern: "mau + noun",
        language: "id",
        explanation: "Expresses desire.",
        examples: [{ target: "Saya mau kopi", gloss: "I want coffee" }],
        sourceSegmentIds: ["S0", "S1"],
        difficulty: "intermediate",
      },
    ],
    dialogue_clips: [
      {
        id: "clip-1",
        startSegmentId: "S0",
        endSegmentId: "S2",
        startSec: 0,
        endSec: 3,
        title: "Ordering coffee",
        description: "A short order exchange.",
        participants: ["student_vincent", "teacher"],
        language: "id",
        focus: "scenario",
      },
    ],
    teacher_corrections: [
      {
        studentSpeaker: "student_vincent",
        segmentId: "S2",
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
      throw new Error("not used in extraction tests");
    },
    diarize: async () => {
      throw new Error("not used in extraction tests");
    },
    extract: async (input) => {
      capturedExtractionInput.value = input;
      return {
        extraction: validExtraction,
        rawResponse: JSON.stringify(validExtraction),
        model: "test-extract-model",
        promptVersion: "extract-v1",
      };
    },
    emailer: {
      sendReady: async () => ({ ok: true, messageId: "msg_test" }),
      sendFailed: async () => ({ ok: true, messageId: "msg_test" }),
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
    capturedExtractionInput,
    services,
  };
}

describe("runLessonPipeline extraction integration", () => {
  it("persists structured extraction rows and records source metadata", async () => {
    const supabase = new FakeSupabase();
    seed(supabase);
    const { steps, services, capturedExtractionInput } = buildSteps();

    const result = await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_1",
      logger: noopLogger,
      steps,
      services,
    });

    expect(result.status).toBe("ready");
    expect(capturedExtractionInput.value?.language).toBe("id");
    expect(capturedExtractionInput.value?.segments[1]?.lowPriority).toBe(true);

    expect(supabase.vocabItems).toHaveLength(1);
    expect(supabase.grammarPatterns).toHaveLength(1);
    expect(supabase.dialogueClips).toHaveLength(1);
    expect(supabase.teacherCorrections).toHaveLength(1);
    expect(supabase.extractionRuns).toHaveLength(4);

    const vocab = supabase.vocabItems[0]!;
    expect(vocab.lemma).toBe("kopi");
    expect(vocab.metadata).toMatchObject({
      model: "test-extract-model",
      prompt_version: "extract-v1",
      source_transcript_id: LESSON_ID,
      source_segment_ids: [`seg-${LESSON_ID}-0`],
      kind: "vocab",
    });

    // One card per household member, each pointing at the shared vocab_item
    // with the lesson context (example sentence + source segments) attached
    // so the review UI can render lesson-specific context later.
    expect(supabase.cards).toHaveLength(2);
    const cardUserIds = supabase.cards.map((c) => c.user_id).sort();
    expect(cardUserIds).toEqual([USER_A, USER_B].sort());
    for (const card of supabase.cards) {
      expect(card.vocab_item_id).toBe(vocab.id);
      expect(card.state).toBe("new");
      expect(card.metadata).toMatchObject({
        source_lesson_id: LESSON_ID,
        source_segment_ids: [`seg-${LESSON_ID}-0`],
        example_sentence: "Saya mau kopi.",
        example_translation: "I want coffee.",
      });
    }

    const dialogue = supabase.dialogueClips[0]!;
    expect(dialogue.storage_path).toBe(
      `household-1/${LESSON_ID}/clips/dialogues/clip-1.mp3`,
    );
    expect(dialogue.metadata).toMatchObject({
      source_segment_ids: [`seg-${LESSON_ID}-0`, `seg-${LESSON_ID}-1`, `seg-${LESSON_ID}-2`],
      kind: "dialogue",
      startSegmentId: "S0",
      endSegmentId: "S2",
    });

    const correction = supabase.teacherCorrections[0]!;
    expect(correction.kind).toBe("grammar");
    expect(correction.metadata).toMatchObject({
      source_segment_ids: [`seg-${LESSON_ID}-2`],
      kind: "corrections",
      category: "grammar",
    });

    const runKinds = supabase.extractionRuns.map((row) => row.kind).sort();
    expect(runKinds).toEqual(["corrections", "dialogue", "grammar", "vocab"]);
    for (const run of supabase.extractionRuns) {
      expect(run.model).toBe("test-extract-model");
      expect(run.prompt_version).toBe("extract-v1");
    }
  });

  it("normalizes and dedupes vocab inside one extraction so the unique index isn't tripped", async () => {
    const supabase = new FakeSupabase();
    seed(supabase);
    const { steps, services } = buildSteps();

    services.extract = async (input) => {
      // Three "different" entries that all collapse to the same dedupe key:
      // case + leading/trailing whitespace differences plus an empty
      // pronunciation that should normalize to the same NULL reading.
      const dupes: ExtractionOutput = {
        schemaVersion: SCHEMA_VERSIONS.extractionOutput,
        promptVersion: "extract-v1",
        language: input.language,
        sourceTranscriptId: input.sourceTranscriptId,
        new_vocab: [
          {
            term: "kopi",
            language: "id",
            gloss: "coffee",
            sourceSegmentIds: ["S0"],
          },
          {
            term: "  Kopi  ",
            language: "id",
            gloss: "coffee (formal)",
            sourceSegmentIds: ["S0"],
          },
          {
            term: "KOPI",
            language: "id",
            pronunciation: "   ",
            gloss: "coffee (loud)",
            sourceSegmentIds: ["S0"],
          },
        ],
        grammar_patterns: [],
        dialogue_clips: [],
        teacher_corrections: [],
      };
      return {
        extraction: dupes,
        rawResponse: JSON.stringify(dupes),
        model: "test-extract-model",
        promptVersion: "extract-v1",
      };
    };

    await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_dedupe",
      logger: noopLogger,
      steps,
      services,
    });

    expect(supabase.vocabItems).toHaveLength(1);
    const vocab = supabase.vocabItems[0]!;
    expect(vocab.lemma).toBe("kopi");
    expect(vocab.reading).toBeNull();

    // Each user gets exactly one card for the deduped word.
    expect(supabase.cards).toHaveLength(2);
    expect(supabase.cards.map((c) => c.user_id).sort()).toEqual([USER_A, USER_B].sort());
  });

  it("reuses a vocab_item from an earlier lesson and skips users who already know the word", async () => {
    const supabase = new FakeSupabase();
    seed(supabase);
    const { steps, services } = buildSteps();

    // Seed an existing vocab_item from a "previous lesson" plus a known-words
    // marker for USER_A. The retried extraction should reuse the same row and
    // only create a card for USER_B.
    const existingVocabId = "vocab-existing-kopi";
    const previousLessonId = "99999999-9999-9999-9999-999999999999";
    supabase.insertVocabItem({
      id: existingVocabId,
      household_id: HOUSEHOLD_ID,
      lesson_id: previousLessonId,
      lemma: "kopi",
      // The fixture extraction sets pronunciation: "kopi", so the dedupe key
      // is `kopi|kopi`. Match it on the existing row so the new lesson reuses
      // this vocab_item instead of inserting a duplicate.
      reading: "kopi",
      translation: "coffee",
      part_of_speech: null,
      example_sentence: "Original example.",
      example_translation: "Original gloss.",
      audio_storage_bucket: null,
      audio_storage_path: null,
      difficulty: null,
      metadata: {},
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    });
    supabase.insertKnownWord({
      user_id: USER_A,
      vocab_item_id: existingVocabId,
      source: "self_report",
      marked_at: new Date(0).toISOString(),
    });

    await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_known_words",
      logger: noopLogger,
      steps,
      services,
    });

    // No new vocab_item was inserted — the household already had "kopi".
    expect(supabase.vocabItems).toHaveLength(1);
    expect(supabase.vocabItems[0]!.id).toBe(existingVocabId);
    // The reused row keeps its original example sentence rather than being
    // overwritten by the new lesson's extraction.
    expect(supabase.vocabItems[0]!.example_sentence).toBe("Original example.");

    // USER_A is skipped because they marked the word known. USER_B gets one
    // card pointing at the shared vocab_item, with the new lesson's example
    // attached as their first-encounter context.
    expect(supabase.cards).toHaveLength(1);
    const card = supabase.cards[0]!;
    expect(card.user_id).toBe(USER_B);
    expect(card.vocab_item_id).toBe(existingVocabId);
    expect(card.metadata).toMatchObject({
      source_lesson_id: LESSON_ID,
      example_sentence: "Saya mau kopi.",
      example_translation: "I want coffee.",
    });
  });

  it("scopes the dedupe lookup to the prepared lemmas and tolerates case differences in stored vocab", async () => {
    const supabase = new FakeSupabase();
    seed(supabase);
    const { steps, services } = buildSteps();

    // Seed an existing row whose stored case differs from the extraction's
    // normalized lemma. The lookup must still find it via the lowercased
    // candidate so the unique index isn't tripped on insert.
    const existingVocabId = "vocab-existing-kopi-cased";
    const previousLessonId = "99999999-9999-9999-9999-999999999998";
    supabase.insertVocabItem({
      id: existingVocabId,
      household_id: HOUSEHOLD_ID,
      lesson_id: previousLessonId,
      lemma: "Kopi",
      reading: "kopi",
      translation: "coffee",
      part_of_speech: null,
      example_sentence: "Original example.",
      example_translation: "Original gloss.",
      audio_storage_bucket: null,
      audio_storage_path: null,
      difficulty: null,
      metadata: {},
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    });
    // An unrelated row that shares the household but not the lemma — proves
    // the scoped query filters it out (the old unscoped query would have
    // pulled it back too, but it's unrelated to the dedupe decision either
    // way).
    supabase.insertVocabItem({
      id: "vocab-unrelated",
      household_id: HOUSEHOLD_ID,
      lesson_id: previousLessonId,
      lemma: "teh",
      reading: null,
      translation: "tea",
      part_of_speech: null,
      example_sentence: null,
      example_translation: null,
      audio_storage_bucket: null,
      audio_storage_path: null,
      difficulty: null,
      metadata: {},
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    });

    await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_case_mismatch",
      logger: noopLogger,
      steps,
      services,
    });

    // The cased existing row was reused — no new vocab_item was inserted for
    // "kopi", so the household still has exactly the seeded two rows.
    expect(supabase.vocabItems).toHaveLength(2);
    const kopi = supabase.vocabItems.find((row) => row.id === existingVocabId)!;
    expect(kopi.lemma).toBe("Kopi");
    expect(kopi.example_sentence).toBe("Original example.");
    // Cards point at the reused vocab_item.
    expect(supabase.cards).toHaveLength(2);
    for (const card of supabase.cards) {
      expect(card.vocab_item_id).toBe(existingVocabId);
    }
  });

  it("reuses mixed-case stored lemmas when a later extraction normalizes them", async () => {
    const supabase = new FakeSupabase();
    seed(supabase);
    const { steps, services } = buildSteps();

    services.extract = async (input) => {
      const extraction: ExtractionOutput = {
        schemaVersion: SCHEMA_VERSIONS.extractionOutput,
        promptVersion: "extract-v1",
        language: input.language,
        sourceTranscriptId: input.sourceTranscriptId,
        new_vocab: [
          {
            term: "iphone",
            language: "id",
            gloss: "iPhone",
            sourceSegmentIds: ["S0"],
          },
        ],
        grammar_patterns: [],
        dialogue_clips: [],
        teacher_corrections: [],
      };
      return {
        extraction,
        rawResponse: JSON.stringify(extraction),
        model: "test-extract-model",
        promptVersion: "extract-v1",
      };
    };

    const existingVocabId = "vocab-existing-iphone";
    supabase.insertVocabItem({
      id: existingVocabId,
      household_id: HOUSEHOLD_ID,
      lesson_id: "99999999-9999-9999-9999-999999999997",
      lemma: "iPhone",
      reading: null,
      translation: "iPhone",
      part_of_speech: null,
      example_sentence: "Original example.",
      example_translation: "Original gloss.",
      audio_storage_bucket: null,
      audio_storage_path: null,
      difficulty: null,
      metadata: {},
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    });

    await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_mixed_case",
      logger: noopLogger,
      steps,
      services,
    });

    expect(supabase.vocabItems).toHaveLength(1);
    expect(supabase.vocabItems[0]!.id).toBe(existingVocabId);
    expect(supabase.cards).toHaveLength(2);
    expect(supabase.cards.map((card) => card.vocab_item_id)).toEqual([
      existingVocabId,
      existingVocabId,
    ]);
  });

  it("is idempotent across extraction retries — re-running does not duplicate cards", async () => {
    const supabase = new FakeSupabase();
    seed(supabase);
    const { steps, services } = buildSteps();

    await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_first",
      logger: noopLogger,
      steps,
      services,
    });

    expect(supabase.vocabItems).toHaveLength(1);
    expect(supabase.cards).toHaveLength(2);
    const firstVocabId = supabase.vocabItems[0]!.id;
    const firstCardIds = supabase.cards.map((c) => c.id).sort();

    // Force the orchestrator into the failed-retry path so the extracting
    // step body actually runs again. The reset hook leaves vocab_items (and
    // thus their cards) in place; the step's reconciliation should reuse the
    // existing rows and the card upsert should be a no-op for duplicates.
    const job = supabase.job();
    job.status = "failed";
    job.failed_at = new Date().toISOString();
    job.error_summary = "simulated post-success rerun";
    const meta = (job.provider_metadata ?? {}) as {
      stages?: Record<string, unknown>;
      last_failure?: { stage: string };
    };
    meta.last_failure = { stage: "extracting" };
    if (meta.stages) delete meta.stages.extracting;
    job.provider_metadata = meta;

    await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_retry",
      logger: noopLogger,
      steps,
      services,
    });

    expect(supabase.vocabItems).toHaveLength(1);
    expect(supabase.vocabItems[0]!.id).toBe(firstVocabId);
    // Cards are stable across retries — same ids, no duplicates.
    expect(supabase.cards).toHaveLength(2);
    expect(supabase.cards.map((c) => c.id).sort()).toEqual(firstCardIds);
  });

  it("fails before writing derived rows when extraction references a missing segment", async () => {
    const supabase = new FakeSupabase();
    seed(supabase);
    const { steps, services } = buildSteps();

    services.extract = async (input) => {
      const bad: ExtractionOutput = {
        schemaVersion: SCHEMA_VERSIONS.extractionOutput,
        promptVersion: "extract-v1",
        language: input.language,
        sourceTranscriptId: input.sourceTranscriptId,
        new_vocab: [
          {
            term: "kopi",
            language: "id",
            gloss: "coffee",
            sourceSegmentIds: ["S99"],
          },
        ],
        grammar_patterns: [],
        dialogue_clips: [],
        teacher_corrections: [],
      };
      return {
        extraction: bad,
        rawResponse: JSON.stringify(bad),
        model: "test-extract-model",
        promptVersion: "extract-v1",
      };
    };

    await expect(
      runLessonPipeline({
        supabase: asClient(supabase),
        payload: { lessonId: LESSON_ID },
        triggerRunId: "run_invalid",
        logger: noopLogger,
        steps,
        services,
      }),
    ).rejects.toThrow(/unknown transcript segment S99/);

    expect(supabase.vocabItems).toHaveLength(0);
    expect(supabase.grammarPatterns).toHaveLength(0);
    expect(supabase.dialogueClips).toHaveLength(0);
    expect(supabase.teacherCorrections).toHaveLength(0);
    expect(supabase.extractionRuns).toHaveLength(0);
  });
});
