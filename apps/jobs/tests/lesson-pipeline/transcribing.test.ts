import { describe, expect, it } from "vitest";
import type { Tables } from "@reverb/db/types";
import { LESSON_AUDIO_BUCKET } from "@reverb/domain/schemas/upload";
import { SCHEMA_VERSIONS, type ExtractionOutput, type Transcript } from "@reverb/domain";
import { runLessonPipeline } from "../../src/lesson-pipeline/orchestrator.js";
import type { ServiceClient } from "../../src/lesson-pipeline/state.js";
import type { PipelineServices } from "../../src/lesson-pipeline/services.js";
import { persistTranscript } from "../../src/lesson-pipeline/steps.js";
import { noopLogger } from "../../src/lesson-pipeline/logger.js";
import { FakeSupabase } from "./fake-supabase.js";

const LESSON_ID = "11111111-2222-3333-4444-555555555555";
const HOUSEHOLD_ID = "household-1";

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
    title: "Transcribing fixture lesson",
    description: null,
    source_language: null,
    target_language: null,
    recorded_at: null,
    status: "processing",
    duration_ms: 60_000,
    metadata: {},
    created_by: null,
    created_at: now,
    updated_at: now,
  };
}

// Seed the orchestrator's prerequisites so it can walk past transcribing into
// the downstream stages without tripping over the lesson / profile lookups
// the extracting step performs.
function seedLessonContext(supabase: FakeSupabase) {
  supabase.insertJob(buildJob());
  supabase.insertFile(buildFile());
  supabase.insertLesson(buildLesson());
}

function asClient(supabase: FakeSupabase): ServiceClient {
  return supabase as unknown as ServiceClient;
}

// Lifted shape of a Groq Whisper verbose_json response for a tiny clip — kept
// inline so the test reads as a single self-contained fixture.
const FIXTURE_RAW = {
  task: "transcribe",
  language: "indonesian",
  duration: 3.0,
  text: " Selamat pagi. Apa kabar?",
  segments: [
    { id: 0, start: 0, end: 1.2, text: " Selamat pagi." },
    { id: 1, start: 1.3, end: 3.0, text: " Apa kabar?" },
  ],
  words: [
    { word: "Selamat", start: 0.05, end: 0.8 },
    { word: "pagi", start: 0.81, end: 1.15 },
    { word: "Apa", start: 1.3, end: 1.7 },
    { word: "kabar", start: 1.71, end: 2.9 },
  ],
};

function fixtureTranscript(): Transcript {
  return {
    schemaVersion: SCHEMA_VERSIONS.transcript,
    sourceId: LESSON_ID,
    language: "id",
    durationSec: 3.0,
    provider: "groq-whisper",
    model: "whisper-large-v3",
    createdAt: new Date(0).toISOString(),
    segments: [
      {
        id: `${LESSON_ID}:seg-0`,
        speaker: "unknown",
        text: "Selamat pagi.",
        start: 0,
        end: 1.2,
        language: "id",
        words: [
          { word: "Selamat", start: 0.05, end: 0.8 },
          { word: "pagi", start: 0.81, end: 1.15 },
        ],
      },
      {
        id: `${LESSON_ID}:seg-1`,
        speaker: "unknown",
        text: "Apa kabar?",
        start: 1.3,
        end: 3.0,
        language: "id",
        words: [
          { word: "Apa", start: 1.3, end: 1.7 },
          { word: "kabar", start: 1.71, end: 2.9 },
        ],
      },
    ],
  };
}

function emptyExtraction(sourceTranscriptId: string): ExtractionOutput {
  return {
    schemaVersion: SCHEMA_VERSIONS.extractionOutput,
    promptVersion: "stub",
    language: "id",
    sourceTranscriptId,
    new_vocab: [],
    grammar_patterns: [],
    dialogue_clips: [],
    teacher_corrections: [],
  };
}

function fixtureServices(): PipelineServices {
  return {
    transcribe: async () => ({
      transcript: fixtureTranscript(),
      rawResponse: FIXTURE_RAW,
      model: "whisper-large-v3",
    }),
    // Diarization labels every fixture segment as 'unknown' with low
    // confidence so the orchestrator advances past the diarizing stage
    // without exercising the real Anthropic call. The persistence assertions
    // below are about transcript_segments / transcript_words, so the speaker
    // labels written here are intentionally bland.
    diarize: async ({ sourceTranscriptId, segments }) => ({
      diarization: {
        schemaVersion: SCHEMA_VERSIONS.diarization,
        promptVersion: "stub",
        model: "stub",
        sourceTranscriptId,
        segments: segments.map((s) => ({
          segmentId: s.id,
          speaker: "unknown" as const,
          confidence: 0,
          lowPriority: false,
        })),
      },
      rawResponse: "{}",
      model: "stub",
      promptVersion: "stub",
    }),
    // Extraction returns no vocab/grammar/etc - these tests are about the
    // transcribing stage; the empty payload lets the orchestrator finish
    // without exercising the Anthropic call or the per-user card writes.
    extract: async ({ sourceTranscriptId, language }) => ({
      extraction: {
        schemaVersion: SCHEMA_VERSIONS.extractionOutput,
        promptVersion: "extract-v1",
        language,
        sourceTranscriptId,
        new_vocab: [],
        grammar_patterns: [],
        dialogue_clips: [],
        teacher_corrections: [],
      },
      rawResponse: "{}",
      model: "stub",
      promptVersion: "extract-v1",
    }),
  };
}

describe("transcribing stage", () => {
  it("persists segments and word timestamps from the adapter output", async () => {
    const supabase = new FakeSupabase();
    seedLessonContext(supabase);

    const result = await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_transcribe",
      logger: noopLogger,
      services: fixtureServices(),
    });

    expect(result.status).toBe("ready");
    expect(supabase.transcriptSegments).toHaveLength(2);
    expect(supabase.transcriptSegments[0]).toMatchObject({
      lesson_id: LESSON_ID,
      segment_index: 0,
      start_ms: 0,
      end_ms: 1200,
      text: "Selamat pagi.",
      language: "id",
    });
    expect(supabase.transcriptSegments[1]).toMatchObject({
      segment_index: 1,
      start_ms: 1300,
      end_ms: 3000,
      text: "Apa kabar?",
    });

    expect(supabase.transcriptWords).toHaveLength(4);
    // Word rows are tied to the segment row that produced them via segment_id.
    const segOneId = supabase.transcriptSegments[0]!.id;
    const segTwoId = supabase.transcriptSegments[1]!.id;
    const wordsForSegOne = supabase.transcriptWords
      .filter((w) => w.segment_id === segOneId)
      .sort((a, b) => a.word_index - b.word_index);
    expect(wordsForSegOne.map((w) => w.text)).toEqual(["Selamat", "pagi"]);
    expect(wordsForSegOne[0]).toMatchObject({
      lesson_id: LESSON_ID,
      word_index: 0,
      start_ms: 50,
      end_ms: 800,
    });
    expect(supabase.transcriptWords.filter((w) => w.segment_id === segTwoId).length).toBe(2);
  });

  it("records the raw provider payload on the job for audit", async () => {
    const supabase = new FakeSupabase();
    seedLessonContext(supabase);

    await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_audit",
      logger: noopLogger,
      services: fixtureServices(),
    });

    const job = supabase.job();
    const meta = job.provider_metadata as Record<string, unknown>;
    const details = meta.transcribing_details as Record<string, unknown> | undefined;
    expect(details).toBeDefined();
    expect(details?.provider).toBe("groq-whisper");
    expect(details?.model).toBe("whisper-large-v3");
    expect(details?.segment_count).toBe(2);
    expect(details?.word_count).toBe(4);
    // The full provider payload is stashed verbatim so a future debug can
    // diff against a re-run without re-fetching the audio.
    expect(details?.raw_response).toEqual(FIXTURE_RAW);
  });

  it("captures provider failures on the job row without losing the raw upload", async () => {
    const supabase = new FakeSupabase();
    seedLessonContext(supabase);
    const failingServices: PipelineServices = {
      transcribe: async () => {
        throw new Error("groq returned 503");
      },
      diarize: async ({ sourceTranscriptId }) => ({
        diarization: {
          schemaVersion: SCHEMA_VERSIONS.diarization,
          promptVersion: "stub",
          model: "stub",
          sourceTranscriptId,
          segments: [],
        },
        rawResponse: "{}",
        model: "stub",
        promptVersion: "stub",
      }),
      extract: async ({ sourceTranscriptId }) => ({
        extraction: emptyExtraction(sourceTranscriptId),
        rawResponse: "{}",
        model: "stub",
        promptVersion: "stub",
      }),
    };

    await expect(
      runLessonPipeline({
        supabase: asClient(supabase),
        payload: { lessonId: LESSON_ID },
        triggerRunId: "run_fail",
        logger: noopLogger,
        services: failingServices,
      }),
    ).rejects.toThrow(/groq returned 503/);

    const job = supabase.job();
    expect(job.status).toBe("failed");
    expect(job.error_summary).toMatch(/groq returned 503/);
    const meta = job.provider_metadata as { last_failure?: { stage?: string } };
    expect(meta.last_failure?.stage).toBe("transcribing");
    // The audio_source row is still intact — the failure must not delete the
    // source recording the user uploaded.
    expect(supabase.files).toHaveLength(1);
    expect(supabase.files[0]?.kind).toBe("audio_source");
  });

  it("handles transcripts that ship segments but no word timestamps", async () => {
    const supabase = new FakeSupabase();
    seedLessonContext(supabase);

    const noWords: Transcript = {
      ...fixtureTranscript(),
      segments: fixtureTranscript().segments.map((seg) => ({
        id: seg.id,
        speaker: seg.speaker,
        text: seg.text,
        start: seg.start,
        end: seg.end,
        language: seg.language,
      })),
    };

    await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_no_words",
      logger: noopLogger,
      services: {
        ...fixtureServices(),
        transcribe: async () => ({
          transcript: noWords,
          rawResponse: { ...FIXTURE_RAW, words: undefined },
          model: "whisper-large-v3",
        }),
      },
    });

    expect(supabase.transcriptSegments).toHaveLength(2);
    expect(supabase.transcriptWords).toHaveLength(0);
  });
});

describe("persistTranscript", () => {
  it("replaces existing rows on a retry rather than duplicating", async () => {
    const supabase = new FakeSupabase();
    // Pretend a prior run left some segments on the lesson.
    supabase.transcriptSegments.push({
      id: "stale-seg",
      lesson_id: LESSON_ID,
      segment_index: 0,
      start_ms: 0,
      end_ms: 9999,
      speaker: null,
      language: "id",
      text: "stale",
      metadata: {},
      created_at: new Date(0).toISOString(),
    });
    supabase.transcriptWords.push({
      id: "stale-word",
      segment_id: "stale-seg",
      lesson_id: LESSON_ID,
      word_index: 0,
      start_ms: 0,
      end_ms: 100,
      text: "stale",
      confidence: null,
      created_at: new Date(0).toISOString(),
    });

    const result = await persistTranscript(asClient(supabase), LESSON_ID, fixtureTranscript());

    expect(result).toEqual({ segmentCount: 2, wordCount: 4 });
    expect(supabase.transcriptSegments.map((s) => s.text)).toEqual(["Selamat pagi.", "Apa kabar?"]);
    // The cascade from the delete cleared the stale word row as well.
    expect(supabase.transcriptWords.find((w) => w.id === "stale-word")).toBeUndefined();
  });
});
