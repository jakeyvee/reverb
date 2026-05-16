// Vocab TTS generation + cache, per VOL-118.
//
// Responsibilities:
//   * For each vocab_item this lesson produced, ensure a TTS asset for the
//     headword exists in the `tts-cache` bucket and a `tts_assets` row points
//     at it.
//   * Reuse an existing cache row when the same household has already paid for
//     the same (text, voice) — Google TTS bills per character, so the dedupe
//     is the whole point.
//   * Write the resulting bucket/path back onto the vocab_item so the review
//     UI can fetch the audio without re-hitting the cache table.
//   * Tolerate per-item failures. The acceptance criterion is "missing TTS
//     does not block card review"; we log the failure and continue rather than
//     letting a single 503 sink the whole pipeline.
//
// Re-runnable. The step skips vocab_items that already have audio attached
// and consults the cache table for the rest — so a retried `generating_audio`
// stage either does nothing (everything cached on the first pass) or only
// processes whatever was missing.

import {
  GOOGLE_TTS_PROVIDER_ID,
  TTS_CACHE_BUCKET,
  estimateCostMicroUsd,
  ttsCacheKey,
  ttsCacheStoragePath,
  type SynthesizeInput,
  type TtsCacheKey,
} from "@reverb/ai";
import type { TablesInsert } from "@reverb/db/types";
import type { ProviderUsageRecorder } from "@reverb/db/usage";
import type { PipelineLogger } from "./logger.js";
import type { ServiceClient } from "./state.js";

export type SynthesizeFn = (input: SynthesizeInput) => Promise<Buffer>;

export type GenerateVocabAudioInput = {
  supabase: ServiceClient;
  synthesize: SynthesizeFn;
  logger: PipelineLogger;
  // VOL-138: every actual Google TTS synthesis writes a provider_usage_events
  // row. Cache hits don't consume the paid API so they're skipped — the cost
  // dashboard reflects spend, not lookups.
  recordUsage: ProviderUsageRecorder;
  lessonId: string;
  householdId: string;
  voiceName?: string;
  languageCode?: string;
};

export type GenerateVocabAudioResult = {
  /** Number of vocab_items considered (lesson-bound, with non-empty lemma). */
  candidateCount: number;
  /** Items that already had an audio_storage_path set on entry. */
  alreadyAttachedCount: number;
  /** Items that resolved to an existing tts_assets row without synthesising. */
  cacheHitCount: number;
  /** Items that triggered a new synthesize call + storage upload. */
  synthesizedCount: number;
  /** Items that failed (provider error, upload error, etc.). */
  failedCount: number;
};

type VocabRowForTts = {
  id: string;
  lemma: string;
  audio_storage_bucket: string | null;
  audio_storage_path: string | null;
};

type CacheLookupRow = {
  id: string;
  storage_bucket: string;
  storage_path: string;
};

// Entry point: pulls every vocab_item this lesson introduced and walks them
// through the cache-then-synthesise pipeline. Returns a summary so the worker
// step can fold it into `provider_metadata.generating_audio_details` for
// audit and debugging.
export async function generateVocabAudioForLesson(
  input: GenerateVocabAudioInput,
): Promise<GenerateVocabAudioResult> {
  const candidates = await loadLessonVocabForTts(input.supabase, input.lessonId);
  const result: GenerateVocabAudioResult = {
    candidateCount: candidates.length,
    alreadyAttachedCount: 0,
    cacheHitCount: 0,
    synthesizedCount: 0,
    failedCount: 0,
  };

  for (const vocab of candidates) {
    if (vocab.audio_storage_path) {
      result.alreadyAttachedCount += 1;
      continue;
    }
    const lemma = vocab.lemma.trim();
    if (lemma.length === 0) {
      // Should not happen — vocab_items.lemma is NOT NULL and the extractor
      // normalises it — but defensively skip rather than crash.
      input.logger.info("Skipping vocab_item with empty lemma", { vocabItemId: vocab.id });
      continue;
    }

    try {
      const outcome = await ensureVocabTtsAsset({
        ...input,
        vocab,
        lemma,
      });
      if (outcome === "cache_hit") result.cacheHitCount += 1;
      if (outcome === "synthesized") result.synthesizedCount += 1;
    } catch (err) {
      result.failedCount += 1;
      input.logger.error("TTS generation failed for vocab item", {
        vocabItemId: vocab.id,
        lemma,
        error: describe(err),
      });
    }
  }

  return result;
}

type EnsureInput = GenerateVocabAudioInput & {
  vocab: VocabRowForTts;
  lemma: string;
};

type EnsureOutcome = "cache_hit" | "synthesized";

async function ensureVocabTtsAsset(args: EnsureInput): Promise<EnsureOutcome> {
  const key = ttsCacheKey({
    text: args.lemma,
    voiceName: args.voiceName,
    languageCode: args.languageCode,
  });

  const cached = await findCachedAsset(args.supabase, args.householdId, key);
  if (cached) {
    await attachAudioToVocab(
      args.supabase,
      args.vocab.id,
      cached.storage_bucket,
      cached.storage_path,
    );
    args.logger.info("Reused cached TTS asset", {
      vocabItemId: args.vocab.id,
      lemma: args.lemma,
      bucket: cached.storage_bucket,
      path: cached.storage_path,
    });
    return "cache_hit";
  }

  const storagePath = ttsCacheStoragePath({ householdId: args.householdId, key });
  const synthesizeStartedAt = Date.now();
  let audio: Buffer;
  try {
    audio = await args.synthesize({
      text: key.text,
      languageCode: key.languageCode,
      voiceName: key.voiceName,
    });
  } catch (err) {
    await args.recordUsage({
      provider: GOOGLE_TTS_PROVIDER_ID,
      operation: "tts",
      surface: "lesson-pipeline.generating_audio.vocab_tts",
      householdId: args.householdId,
      lessonId: args.lessonId,
      model: key.voiceName,
      status: "failed",
      characterCount: key.text.length,
      latencyMs: Date.now() - synthesizeStartedAt,
      error: describe(err),
      metadata: { vocab_item_id: args.vocab.id, language_code: key.languageCode },
    });
    throw err;
  }
  if (!audio || audio.length === 0) {
    await args.recordUsage({
      provider: GOOGLE_TTS_PROVIDER_ID,
      operation: "tts",
      surface: "lesson-pipeline.generating_audio.vocab_tts",
      householdId: args.householdId,
      lessonId: args.lessonId,
      model: key.voiceName,
      status: "failed",
      characterCount: key.text.length,
      latencyMs: Date.now() - synthesizeStartedAt,
      error: "Synthesizer returned empty audio buffer",
      metadata: { vocab_item_id: args.vocab.id, language_code: key.languageCode },
    });
    throw new Error("Synthesizer returned empty audio buffer");
  }
  await args.recordUsage({
    provider: GOOGLE_TTS_PROVIDER_ID,
    operation: "tts",
    surface: "lesson-pipeline.generating_audio.vocab_tts",
    householdId: args.householdId,
    lessonId: args.lessonId,
    model: key.voiceName,
    characterCount: key.text.length,
    latencyMs: Date.now() - synthesizeStartedAt,
    costMicroUsd: estimateCostMicroUsd({
      provider: "google-tts",
      voiceName: key.voiceName,
      characterCount: key.text.length,
    }),
    metadata: {
      vocab_item_id: args.vocab.id,
      language_code: key.languageCode,
      byte_size: audio.length,
    },
  });

  await uploadTtsObject(args.supabase, storagePath, audio);
  const inserted = await insertCacheRow(args.supabase, {
    householdId: args.householdId,
    key,
    storagePath,
    byteSize: audio.length,
  });
  // Race-safe: if another worker (or a parallel iteration of this loop)
  // inserted the same row first, `inserted` is null and we still attach the
  // canonical storage path. The object upload is idempotent thanks to
  // `upsert: true` on the storage call.
  await attachAudioToVocab(args.supabase, args.vocab.id, TTS_CACHE_BUCKET, storagePath);
  args.logger.info("Synthesized TTS asset", {
    vocabItemId: args.vocab.id,
    lemma: args.lemma,
    bucket: TTS_CACHE_BUCKET,
    path: storagePath,
    bytes: audio.length,
    cacheRowInserted: Boolean(inserted),
  });
  return "synthesized";
}

async function loadLessonVocabForTts(
  supabase: ServiceClient,
  lessonId: string,
): Promise<VocabRowForTts[]> {
  const { data, error } = await supabase
    .from("vocab_items")
    .select("id, lemma, audio_storage_bucket, audio_storage_path")
    .eq("lesson_id", lessonId);
  if (error) {
    throw new Error(`Could not load vocab_items for lesson ${lessonId}: ${error.message}`);
  }
  return (data ?? []) as VocabRowForTts[];
}

async function findCachedAsset(
  supabase: ServiceClient,
  householdId: string,
  key: TtsCacheKey,
): Promise<CacheLookupRow | null> {
  const { data, error } = await supabase
    .from("tts_assets")
    .select("id, storage_bucket, storage_path")
    .eq("household_id", householdId)
    .eq("text_hash", key.hash)
    .eq("voice_name", key.voiceName)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not query tts_assets cache: ${error.message}`);
  }
  return (data ?? null) as CacheLookupRow | null;
}

async function uploadTtsObject(
  supabase: ServiceClient,
  storagePath: string,
  audio: Buffer,
): Promise<void> {
  const { error } = await supabase.storage.from(TTS_CACHE_BUCKET).upload(storagePath, audio, {
    contentType: "audio/mpeg",
    // `upsert: true` is what makes the write idempotent across retries: a
    // second pass with the same deterministic path overwrites instead of
    // colliding on the bucket's (bucket, path) unique constraint.
    upsert: true,
  });
  if (error) {
    throw new Error(
      `Could not upload TTS object to ${TTS_CACHE_BUCKET}/${storagePath}: ${error.message}`,
    );
  }
}

async function insertCacheRow(
  supabase: ServiceClient,
  args: {
    householdId: string;
    key: TtsCacheKey;
    storagePath: string;
    byteSize: number;
  },
): Promise<{ id: string } | null> {
  const row: TablesInsert<"tts_assets"> = {
    household_id: args.householdId,
    text_hash: args.key.hash,
    text: args.key.text,
    language_code: args.key.languageCode,
    voice_name: args.key.voiceName,
    provider: GOOGLE_TTS_PROVIDER_ID,
    storage_bucket: TTS_CACHE_BUCKET,
    storage_path: args.storagePath,
    byte_size: args.byteSize,
    metadata: {},
  };
  // Two parallel workers can race here. The unique index on
  // (household_id, text_hash, voice_name) makes the second insert error out;
  // we swallow the duplicate error so the caller still attaches the audio.
  const { data, error } = await supabase
    .from("tts_assets")
    .upsert(row, {
      onConflict: "household_id,text_hash,voice_name",
      ignoreDuplicates: true,
    })
    .select("id")
    .maybeSingle();
  if (error) {
    throw new Error(`Could not insert tts_assets row: ${error.message}`);
  }
  return data as { id: string } | null;
}

async function attachAudioToVocab(
  supabase: ServiceClient,
  vocabItemId: string,
  bucket: string,
  storagePath: string,
): Promise<void> {
  const { error } = await supabase
    .from("vocab_items")
    .update({ audio_storage_bucket: bucket, audio_storage_path: storagePath })
    .eq("id", vocabItemId);
  if (error) {
    throw new Error(`Could not attach audio to vocab_item ${vocabItemId}: ${error.message}`);
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Unknown TTS error";
}
