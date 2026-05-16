import { describe, expect, it, vi } from "vitest";
import type { Tables } from "@reverb/db/types";
import { LESSON_AUDIO_BUCKET } from "@reverb/domain/schemas/upload";
import {
  SCHEMA_VERSIONS,
  type DiarizationInput,
  type DiarizationOutput,
  type ExtractionOutput,
  type Transcript,
} from "@reverb/domain";
import { runLessonPipeline } from "../../src/lesson-pipeline/orchestrator.js";
import type { ServiceClient } from "../../src/lesson-pipeline/state.js";
import type { PipelineServices } from "../../src/lesson-pipeline/services.js";
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

function buildLesson(): Tables<"lessons"> {
  const now = new Date(0).toISOString();
  return {
    id: LESSON_ID,
    household_id: HOUSEHOLD_ID,
    title: "Diarizing lesson",
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

function seed(supabase: FakeSupabase, jobOverrides: Partial<Tables<"lesson_jobs">> = {}): void {
  supabase.insertJob(buildJob(jobOverrides));
  supabase.insertFile(buildFile());
  supabase.insertLesson(buildLesson());
}

function asClient(supabase: FakeSupabase): ServiceClient {
  return supabase as unknown as ServiceClient;
}

// Five-segment correction exchange. The diarizing step receives these from
// transcript_segments after the transcribing stage runs.
function correctionExchangeTranscript(): Transcript {
  return {
    schemaVersion: SCHEMA_VERSIONS.transcript,
    sourceId: LESSON_ID,
    language: "id",
    durationSec: 16,
    provider: "groq-whisper",
    model: "whisper-large-v3",
    createdAt: new Date(0).toISOString(),
    segments: [
      {
        id: `${LESSON_ID}:seg-0`,
        speaker: "unknown",
        text: "Selamat pagi semuanya. Hari ini kita belajar tentang waktu.",
        start: 0,
        end: 4.2,
        language: "id",
      },
      {
        id: `${LESSON_ID}:seg-1`,
        speaker: "unknown",
        text: "Saya pergi sekolah kemarin.",
        start: 4.5,
        end: 6.8,
        language: "id",
      },
      {
        id: `${LESSON_ID}:seg-2`,
        speaker: "unknown",
        text: "Bagus. Tapi seharusnya: Saya pergi ke sekolah kemarin.",
        start: 7.0,
        end: 10.4,
        language: "id",
      },
      {
        id: `${LESSON_ID}:seg-3`,
        speaker: "unknown",
        text: "So you need the preposition ke before sekolah.",
        start: 10.6,
        end: 13.2,
        language: "id",
      },
      {
        id: `${LESSON_ID}:seg-4`,
        speaker: "unknown",
        text: "Saya pergi ke pasar kemarin.",
        start: 13.5,
        end: 16.0,
        language: "id",
      },
    ],
  };
}

type DiarizeStub = (input: DiarizationInput) => DiarizationOutput;

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

function buildServices(diarizeStub: DiarizeStub): PipelineServices & {
  diarize: ReturnType<typeof vi.fn>;
} {
  const transcript = correctionExchangeTranscript();
  const diarize = vi.fn(async (input: DiarizationInput) => ({
    diarization: diarizeStub(input),
    rawResponse: "{}",
    model: "claude-haiku-4-5-20251001",
    promptVersion: "diarization-v1",
  }));
  return {
    transcribe: async () => ({
      transcript,
      rawResponse: { text: "" },
      model: "whisper-large-v3",
    }),
    diarize,
    extract: async ({ sourceTranscriptId }) => ({
      extraction: emptyExtraction(sourceTranscriptId),
      rawResponse: "{}",
      model: "stub",
      promptVersion: "stub",
    }),
  };
}

describe("diarizing stage", () => {
  it("labels each transcript segment without overwriting the original ASR text", async () => {
    const supabase = new FakeSupabase();
    seed(supabase);

    const services = buildServices((input) => ({
      schemaVersion: SCHEMA_VERSIONS.diarization,
      promptVersion: "diarization-v1",
      model: "claude-haiku-4-5-20251001",
      sourceTranscriptId: input.sourceTranscriptId,
      segments: [
        { segmentId: "S0", speaker: "teacher", confidence: 0.95, lowPriority: false },
        { segmentId: "S1", speaker: "student_vincent", confidence: 0.78, lowPriority: false },
        {
          segmentId: "S2",
          speaker: "teacher",
          confidence: 0.92,
          lowPriority: false,
          notes: "explicit correction phrase 'seharusnya'",
        },
        {
          segmentId: "S3",
          speaker: "teacher",
          confidence: 0.85,
          lowPriority: true,
          notes: "English meta-explanation",
        },
        { segmentId: "S4", speaker: "student_gf", confidence: 0.65, lowPriority: false },
      ],
    }));

    const result = await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_diarize",
      logger: noopLogger,
      services,
    });

    expect(result.status).toBe("ready");

    const segments = [...supabase.transcriptSegments].sort(
      (a, b) => a.segment_index - b.segment_index,
    );
    expect(segments).toHaveLength(5);

    // Speaker labels are persisted on the segment rows.
    expect(segments.map((s) => s.speaker)).toEqual([
      "teacher",
      "student_vincent",
      "teacher",
      "teacher",
      "student_gf",
    ]);

    // ASR text is preserved verbatim — diarization does not rewrite text.
    expect(segments.map((s) => s.text)).toEqual([
      "Selamat pagi semuanya. Hari ini kita belajar tentang waktu.",
      "Saya pergi sekolah kemarin.",
      "Bagus. Tapi seharusnya: Saya pergi ke sekolah kemarin.",
      "So you need the preposition ke before sekolah.",
      "Saya pergi ke pasar kemarin.",
    ]);

    // Confidence and notes land on the row alongside the label.
    expect(segments[2]?.speaker_confidence).toBeCloseTo(0.92);
    expect(segments[2]?.speaker_notes).toMatch(/seharusnya/);
    // Code-switched English segment is flagged so extraction skips it.
    expect(segments[3]?.speaker_low_priority).toBe(true);
    // Indonesian segments stay full-priority for extraction.
    expect(segments[0]?.speaker_low_priority).toBe(false);
  });

  it("stores prompt + model version on the job for future reprocessing", async () => {
    const supabase = new FakeSupabase();
    seed(supabase);

    const services = buildServices((input) => ({
      schemaVersion: SCHEMA_VERSIONS.diarization,
      promptVersion: "diarization-v1",
      model: "claude-haiku-4-5-20251001",
      sourceTranscriptId: input.sourceTranscriptId,
      segments: input.segments.map((s) => ({
        segmentId: s.id,
        speaker: "teacher" as const,
        confidence: 0.9,
        lowPriority: false,
      })),
    }));

    await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_meta",
      logger: noopLogger,
      services,
    });

    const job = supabase.job();
    const meta = job.provider_metadata as Record<string, unknown>;
    const details = meta.diarizing_details as Record<string, unknown> | undefined;
    expect(details).toBeDefined();
    expect(details?.provider).toBe("anthropic-diarization");
    expect(details?.model).toBe("claude-haiku-4-5-20251001");
    expect(details?.prompt_version).toBe("diarization-v1");
    expect(details?.schema_version).toBe(SCHEMA_VERSIONS.diarization);
    expect(details?.segment_count).toBe(5);
    expect(details?.labeled_count).toBe(5);
  });

  it("handles ambiguous segments by recording 'unknown' without failing the lesson", async () => {
    const supabase = new FakeSupabase();
    seed(supabase);

    const services = buildServices((input) => ({
      schemaVersion: SCHEMA_VERSIONS.diarization,
      promptVersion: "diarization-v1",
      model: "claude-haiku-4-5-20251001",
      sourceTranscriptId: input.sourceTranscriptId,
      // The model is uncertain about S1 and S4 — the system prompt forces
      // it to return `unknown` rather than guess, which the pipeline must
      // tolerate without failing the lesson.
      segments: [
        { segmentId: "S0", speaker: "teacher", confidence: 0.95, lowPriority: false },
        { segmentId: "S1", speaker: "unknown", confidence: 0.2, lowPriority: false },
        { segmentId: "S2", speaker: "teacher", confidence: 0.88, lowPriority: false },
        { segmentId: "S3", speaker: "teacher", confidence: 0.8, lowPriority: true },
        { segmentId: "S4", speaker: "unknown", confidence: 0.3, lowPriority: false },
      ],
    }));

    const result = await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_ambiguous",
      logger: noopLogger,
      services,
    });

    expect(result.status).toBe("ready");
    const job = supabase.job();
    expect(job.status).toBe("ready");

    const segments = [...supabase.transcriptSegments].sort(
      (a, b) => a.segment_index - b.segment_index,
    );
    expect(segments[1]?.speaker).toBe("unknown");
    expect(segments[1]?.speaker_confidence).toBeCloseTo(0.2);
    expect(segments[4]?.speaker).toBe("unknown");

    const meta = job.provider_metadata as Record<string, unknown>;
    const details = meta.diarizing_details as Record<string, unknown> | undefined;
    expect(details?.unknown_count).toBe(2);
    expect(details?.labeled_count).toBe(5);
  });

  it("leaves segments missing from the LLM response unchanged so a partial response cannot blank prior labels", async () => {
    const supabase = new FakeSupabase();
    seed(supabase);

    const services = buildServices((input) => ({
      schemaVersion: SCHEMA_VERSIONS.diarization,
      promptVersion: "diarization-v1",
      model: "claude-haiku-4-5-20251001",
      sourceTranscriptId: input.sourceTranscriptId,
      // Only labels S0–S2; S3 and S4 are missing from the response.
      segments: [
        { segmentId: "S0", speaker: "teacher", confidence: 0.9, lowPriority: false },
        { segmentId: "S1", speaker: "student_vincent", confidence: 0.7, lowPriority: false },
        { segmentId: "S2", speaker: "teacher", confidence: 0.85, lowPriority: false },
      ],
    }));

    await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_partial",
      logger: noopLogger,
      services,
    });

    const segments = [...supabase.transcriptSegments].sort(
      (a, b) => a.segment_index - b.segment_index,
    );
    expect(segments[0]?.speaker).toBe("teacher");
    expect(segments[2]?.speaker).toBe("teacher");
    // Missing rows keep their pre-diarization speaker (null from transcribing).
    expect(segments[3]?.speaker).toBeNull();
    expect(segments[4]?.speaker).toBeNull();

    const job = supabase.job();
    const meta = job.provider_metadata as Record<string, unknown>;
    const details = meta.diarizing_details as Record<string, unknown> | undefined;
    expect(details?.missing_count).toBe(2);
  });

  it("captures provider failures without losing the persisted transcript", async () => {
    const supabase = new FakeSupabase();
    seed(supabase);

    const services: PipelineServices = {
      transcribe: async () => ({
        transcript: correctionExchangeTranscript(),
        rawResponse: { text: "" },
        model: "whisper-large-v3",
      }),
      diarize: async () => {
        throw new Error("anthropic returned 503");
      },
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
        services,
      }),
    ).rejects.toThrow(/anthropic returned 503/);

    const job = supabase.job();
    expect(job.status).toBe("failed");
    const meta = job.provider_metadata as { last_failure?: { stage?: string } };
    expect(meta.last_failure?.stage).toBe("diarizing");

    // Transcribing already wrote the segments; a diarization failure must not
    // delete or rewrite them.
    expect(supabase.transcriptSegments).toHaveLength(5);
    expect(supabase.transcriptSegments[0]?.text).toBe(
      "Selamat pagi semuanya. Hari ini kita belajar tentang waktu.",
    );
  });

  it("skips the LLM call entirely when the transcript has zero segments", async () => {
    const supabase = new FakeSupabase();
    seed(supabase);

    const diarize = vi.fn();
    const services: PipelineServices = {
      transcribe: async () => ({
        transcript: {
          schemaVersion: SCHEMA_VERSIONS.transcript,
          sourceId: LESSON_ID,
          language: "id",
          durationSec: 0,
          provider: "groq-whisper",
          model: "whisper-large-v3",
          segments: [],
          createdAt: new Date(0).toISOString(),
        },
        rawResponse: { text: "" },
        model: "whisper-large-v3",
      }),
      diarize,
      extract: async ({ sourceTranscriptId }) => ({
        extraction: emptyExtraction(sourceTranscriptId),
        rawResponse: "{}",
        model: "stub",
        promptVersion: "stub",
      }),
    };

    const result = await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_empty",
      logger: noopLogger,
      services,
    });

    expect(result.status).toBe("ready");
    expect(diarize).not.toHaveBeenCalled();

    const job = supabase.job();
    const meta = job.provider_metadata as Record<string, unknown>;
    const details = meta.diarizing_details as Record<string, unknown> | undefined;
    expect(details?.provider).toBe("noop");
    expect(details?.segment_count).toBe(0);
  });
});
