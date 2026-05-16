import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import type { Tables } from "@reverb/db/types";
import {
  DEFAULT_INDONESIAN_VOICE,
  GOOGLE_TTS_PROVIDER_ID,
  INDONESIAN_LANGUAGE_CODE,
  TTS_CACHE_BUCKET,
  type SynthesizeInput,
  ttsCacheKey,
  ttsCacheStoragePath,
} from "@reverb/ai";
import { SCHEMA_VERSIONS, type ExtractionOutput } from "@reverb/domain";
import { LESSON_AUDIO_BUCKET } from "@reverb/domain/schemas/upload";
import { runLessonPipeline } from "../../src/lesson-pipeline/orchestrator.js";
import { generateVocabAudioForLesson } from "../../src/lesson-pipeline/tts.js";
import { noopLogger } from "../../src/lesson-pipeline/logger.js";
import type { ServiceClient } from "../../src/lesson-pipeline/state.js";
import type { PipelineServices } from "../../src/lesson-pipeline/services.js";
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
    title: "TTS fixture lesson",
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

function buildExtraction(terms: string[]): ExtractionOutput {
  return {
    schemaVersion: SCHEMA_VERSIONS.extractionOutput,
    promptVersion: "extract-v1",
    language: "id",
    sourceTranscriptId: LESSON_ID,
    new_vocab: terms.map((term) => ({
      term,
      language: "id",
      gloss: `${term} (en)`,
      sourceSegmentIds: ["S0"],
    })),
    grammar_patterns: [],
    dialogue_clips: [],
    teacher_corrections: [],
  };
}

type SynthCall = { input: SynthesizeInput };

function buildServices(
  extraction: ExtractionOutput,
  synthOpts: { calls: SynthCall[]; failTerms?: Set<string> } = { calls: [] },
): PipelineServices {
  return {
    transcribe: async () => {
      throw new Error("not used");
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
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
    extract: async () => ({
      extraction,
      rawResponse: JSON.stringify(extraction),
      model: "test-extract-model",
      promptVersion: "extract-v1",
      usage: { inputTokens: 0, outputTokens: 0 },
    }),
    // The generating-audio tests use extractions with no grammar patterns,
    // so this stub never gets called — but the field is required by the
    // PipelineServices type for non-extracting tests that pull the same
    // builder shape (none do today; this keeps the seam explicit).
    generateGrammarExercises: async () => {
      throw new Error("generateGrammarExercises should not be called in this fixture");
    },
    synthesize: async (input) => {
      synthOpts.calls.push({ input });
      if (synthOpts.failTerms?.has(input.text)) {
        throw new Error(`google tts 503 for ${input.text}`);
      }
      // Return a deterministic-but-non-empty buffer keyed on the text so the
      // upload assertions can distinguish payloads. Real Wavenet output is
      // larger; size is irrelevant to the cache logic.
      return Buffer.from(`audio:${input.text}`, "utf8");
    },
    emailer: {
      sendReady: async () => ({ ok: true, messageId: "msg" }),
      sendFailed: async () => ({ ok: true, messageId: "msg" }),
    },
    resolveRecipientEmail: async (userId) => `${userId}@example.test`,
    resolveVincentEmail: () => "vincent@example.test",
  };
}

// Pre-populate transcript_segments + the lesson so the orchestrator's
// transcribing/diarizing stages can be skipped via stage completion markers,
// leaving the extracting + generating_audio stages to do real work against
// the fake. Mirrors the technique the extracting test uses but inverted —
// here we want extracting + audio to run, not transcribing.
function preCompleteStages(supabase: FakeSupabase, stages: string[]): void {
  const job = supabase.job();
  const now = new Date().toISOString();
  const meta = (job.provider_metadata ?? {}) as {
    stages?: Record<string, { completed_at: string }>;
  };
  meta.stages = meta.stages ?? {};
  for (const stage of stages) {
    meta.stages[stage] = { completed_at: now };
  }
  job.provider_metadata = meta;
  // Seed a transcript segment so extracting has segments to extract from.
  supabase.transcriptSegments.push({
    id: `seg-${LESSON_ID}-0`,
    lesson_id: LESSON_ID,
    segment_index: 0,
    start_ms: 0,
    end_ms: 3000,
    speaker: null,
    speaker_confidence: null,
    speaker_notes: null,
    speaker_low_priority: false,
    language: "id",
    text: "Saya mau kopi.",
    metadata: {},
    created_at: now,
  });
}

describe("generating_audio stage", () => {
  it("synthesises audio, caches it, and points vocab_items at the cache object", async () => {
    const supabase = new FakeSupabase();
    seed(supabase);
    preCompleteStages(supabase, ["transcribing", "diarizing"]);
    const calls: SynthCall[] = [];
    const services = buildServices(buildExtraction(["kopi"]), { calls });

    const result = await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_synth",
      logger: noopLogger,
      services,
    });
    expect(result.status).toBe("ready");

    // The synthesizer was called exactly once with the canonicalised text and
    // the pinned MVP voice / language. This is the request-mapping check the
    // acceptance criteria call out.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toMatchObject({
      text: "kopi",
      languageCode: INDONESIAN_LANGUAGE_CODE,
      voiceName: DEFAULT_INDONESIAN_VOICE,
    });

    // One MP3 landed in the private tts-cache bucket at the deterministic
    // path the cache key derives. The household prefix matches the storage
    // RLS policy from 20260514120007_storage_buckets.sql.
    const key = ttsCacheKey({ text: "kopi" });
    const expectedPath = ttsCacheStoragePath({ householdId: HOUSEHOLD_ID, key });
    expect(supabase.storageUploads).toHaveLength(1);
    expect(supabase.storageUploads[0]).toMatchObject({
      bucket: TTS_CACHE_BUCKET,
      path: expectedPath,
      contentType: "audio/mpeg",
      upsert: true,
    });
    expect(supabase.storageUploads[0]?.byteSize).toBeGreaterThan(0);

    // A tts_assets row catalogues the upload so future lessons / users can
    // reuse it without re-synthesising.
    expect(supabase.ttsAssets).toHaveLength(1);
    const asset = supabase.ttsAssets[0]!;
    expect(asset).toMatchObject({
      household_id: HOUSEHOLD_ID,
      text: "kopi",
      text_hash: key.hash,
      voice_name: DEFAULT_INDONESIAN_VOICE,
      language_code: INDONESIAN_LANGUAGE_CODE,
      provider: GOOGLE_TTS_PROVIDER_ID,
      storage_bucket: TTS_CACHE_BUCKET,
      storage_path: expectedPath,
    });
    expect(asset.byte_size).toBeGreaterThan(0);

    // The vocab_item carries the audio reference so the review UI can fetch
    // it without consulting the cache table.
    expect(supabase.vocabItems).toHaveLength(1);
    const vocab = supabase.vocabItems[0]!;
    expect(vocab.audio_storage_bucket).toBe(TTS_CACHE_BUCKET);
    expect(vocab.audio_storage_path).toBe(expectedPath);

    // The summary lands on the job for audit.
    const meta = supabase.job().provider_metadata as Record<string, unknown>;
    const details = meta.generating_audio_details as Record<string, unknown> | undefined;
    expect(details).toMatchObject({
      provider: GOOGLE_TTS_PROVIDER_ID,
      voice: DEFAULT_INDONESIAN_VOICE,
      language_code: INDONESIAN_LANGUAGE_CODE,
      candidate_count: 1,
      already_attached_count: 0,
      cache_hit_count: 0,
      synthesized_count: 1,
      failed_count: 0,
    });
  });

  it("reuses an existing tts_assets entry instead of paying Google again", async () => {
    const supabase = new FakeSupabase();
    seed(supabase);
    preCompleteStages(supabase, ["transcribing", "diarizing"]);

    // Pre-populate the cache as if a previous lesson already synthesised
    // "kopi" for this household.
    const key = ttsCacheKey({ text: "kopi" });
    const cachedPath = ttsCacheStoragePath({ householdId: HOUSEHOLD_ID, key });
    supabase.insertTtsAsset({
      id: "cache-existing",
      household_id: HOUSEHOLD_ID,
      text: "kopi",
      text_hash: key.hash,
      language_code: key.languageCode,
      voice_name: key.voiceName,
      provider: GOOGLE_TTS_PROVIDER_ID,
      storage_bucket: TTS_CACHE_BUCKET,
      storage_path: cachedPath,
      byte_size: 4096,
      metadata: {},
      created_at: new Date(0).toISOString(),
    });

    const calls: SynthCall[] = [];
    const services = buildServices(buildExtraction(["kopi"]), { calls });

    await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_cache_hit",
      logger: noopLogger,
      services,
    });

    // Google was never called, no upload happened, and the cache table did
    // not grow — but the vocab_item still ended up pointing at the cached
    // object so the UI can play it back.
    expect(calls).toHaveLength(0);
    expect(supabase.storageUploads).toHaveLength(0);
    expect(supabase.ttsAssets).toHaveLength(1);
    expect(supabase.ttsAssets[0]?.id).toBe("cache-existing");
    expect(supabase.vocabItems).toHaveLength(1);
    expect(supabase.vocabItems[0]?.audio_storage_path).toBe(cachedPath);

    const meta = supabase.job().provider_metadata as Record<string, unknown>;
    const details = meta.generating_audio_details as Record<string, unknown> | undefined;
    expect(details).toMatchObject({
      candidate_count: 1,
      cache_hit_count: 1,
      synthesized_count: 0,
      failed_count: 0,
    });
  });

  it("is idempotent: a second run on cached vocab is a no-op", async () => {
    const supabase = new FakeSupabase();
    seed(supabase);
    preCompleteStages(supabase, ["transcribing", "diarizing"]);
    const calls: SynthCall[] = [];
    const services = buildServices(buildExtraction(["kopi"]), { calls });

    await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_first",
      logger: noopLogger,
      services,
    });
    expect(calls).toHaveLength(1);
    expect(supabase.storageUploads).toHaveLength(1);
    expect(supabase.vocabItems[0]?.audio_storage_path).not.toBeNull();

    // Simulate the orchestrator re-entering the generating_audio stage after
    // a failure further down the line. The summary should show every vocab
    // item already attached and the synthesizer should never run again.
    const second = await generateVocabAudioForLesson({
      supabase: asClient(supabase),
      synthesize: services.synthesize,
      logger: noopLogger,
      lessonId: LESSON_ID,
      householdId: HOUSEHOLD_ID,
    });
    expect(second).toEqual({
      candidateCount: 1,
      alreadyAttachedCount: 1,
      cacheHitCount: 0,
      synthesizedCount: 0,
      failedCount: 0,
    });
    expect(calls).toHaveLength(1);
    expect(supabase.storageUploads).toHaveLength(1);
  });

  it("does not block the pipeline when a single TTS call fails — UI degrades gracefully", async () => {
    const supabase = new FakeSupabase();
    seed(supabase);
    preCompleteStages(supabase, ["transcribing", "diarizing"]);
    const calls: SynthCall[] = [];
    const services = buildServices(buildExtraction(["kopi", "teh"]), {
      calls,
      failTerms: new Set(["teh"]),
    });

    const result = await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_partial_fail",
      logger: noopLogger,
      services,
    });

    // Lesson still completes — the acceptance criterion is "missing TTS does
    // not block card review".
    expect(result.status).toBe("ready");
    const job = supabase.job();
    expect(job.status).toBe("ready");

    // "kopi" succeeded, "teh" failed. Both vocab_items exist so the cards
    // backing them can still be reviewed silently.
    expect(supabase.vocabItems).toHaveLength(2);
    const kopi = supabase.vocabItems.find((row) => row.lemma === "kopi")!;
    const teh = supabase.vocabItems.find((row) => row.lemma === "teh")!;
    expect(kopi.audio_storage_path).not.toBeNull();
    expect(teh.audio_storage_path).toBeNull();

    // Cache table records only the successful synthesis.
    expect(supabase.ttsAssets).toHaveLength(1);
    expect(supabase.ttsAssets[0]?.text).toBe("kopi");

    const meta = job.provider_metadata as Record<string, unknown>;
    const details = meta.generating_audio_details as Record<string, unknown> | undefined;
    expect(details).toMatchObject({
      candidate_count: 2,
      synthesized_count: 1,
      failed_count: 1,
    });
  });

  it("collapses case-only variants to a single cache entry shared by both lemmas", async () => {
    const supabase = new FakeSupabase();
    seed(supabase);
    preCompleteStages(supabase, ["transcribing", "diarizing"]);
    const calls: SynthCall[] = [];
    const services = buildServices(buildExtraction(["KOPI"]), { calls });

    // Pre-cache the lower-case form. The new "KOPI" lemma normalises to the
    // same hash and should reuse the cached object without calling Google.
    const key = ttsCacheKey({ text: "kopi" });
    const cachedPath = ttsCacheStoragePath({ householdId: HOUSEHOLD_ID, key });
    supabase.insertTtsAsset({
      id: "cache-existing",
      household_id: HOUSEHOLD_ID,
      text: "kopi",
      text_hash: key.hash,
      language_code: key.languageCode,
      voice_name: key.voiceName,
      provider: GOOGLE_TTS_PROVIDER_ID,
      storage_bucket: TTS_CACHE_BUCKET,
      storage_path: cachedPath,
      byte_size: 4096,
      metadata: {},
      created_at: new Date(0).toISOString(),
    });

    await runLessonPipeline({
      supabase: asClient(supabase),
      payload: { lessonId: LESSON_ID },
      triggerRunId: "run_case_dedupe",
      logger: noopLogger,
      services,
    });

    expect(calls).toHaveLength(0);
    expect(supabase.storageUploads).toHaveLength(0);
    expect(supabase.vocabItems).toHaveLength(1);
    expect(supabase.vocabItems[0]?.audio_storage_path).toBe(cachedPath);
  });
});
