import { toFile } from "groq-sdk";
import { z } from "zod";
import {
  SCHEMA_VERSIONS,
  TranscriptSchema,
  type Transcript,
  type TranscriptSegment,
  type WordTimestamp,
} from "@reverb/domain";
import { getGroqClient } from "./groq.js";

// Whisper-large-v3 is the only ASR model Groq exposes today; pin it so changes
// to the upstream default surface as a code change rather than silent drift.
export const GROQ_WHISPER_MODEL = "whisper-large-v3";
export const GROQ_WHISPER_PROVIDER_ID = "groq-whisper";

// Word- and segment-level entries from Whisper's `verbose_json` response.
// Modeled here as a zod schema so we can validate the provider payload before
// trusting it; Groq's SDK types only declare `{ text: string }`.
const GroqWordSchema = z.object({
  word: z.string(),
  start: z.number().nonnegative().finite(),
  end: z.number().nonnegative().finite(),
});

const GroqSegmentSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  start: z.number().nonnegative().finite(),
  end: z.number().nonnegative().finite(),
  text: z.string(),
  avg_logprob: z.number().optional(),
  no_speech_prob: z.number().optional(),
  // Per-segment words appear when `timestamp_granularities` includes "word".
  words: z.array(GroqWordSchema).optional(),
});

export const GroqVerboseTranscriptionSchema = z.object({
  task: z.string().optional(),
  language: z.string().optional(),
  duration: z.number().nonnegative().optional(),
  text: z.string(),
  // Top-level `words` is what Groq returns when granularities=["word"] only.
  words: z.array(GroqWordSchema).optional(),
  segments: z.array(GroqSegmentSchema).optional(),
});

export type GroqVerboseTranscription = z.infer<typeof GroqVerboseTranscriptionSchema>;

export interface TranscribeAudioInput {
  /** Short-lived URL the adapter fetches the audio bytes from. */
  audioUrl: string;
  /** ISO-639-1 language code; e.g. "id" for Indonesian. */
  language: string;
  /** Stable identifier persisted on the resulting Transcript.sourceId. */
  sourceId: string;
  /** File name supplied to the multipart upload — used only by Groq for MIME sniffing. */
  fileName?: string;
  /** Optional context prompt to bias decoding (must match the audio language). */
  prompt?: string;
  /** Override the default Whisper model. */
  model?: string;
}

export interface TranscribeAudioResult {
  /** Domain-validated transcript ready to persist into normalized tables. */
  transcript: Transcript;
  /** Untouched provider payload, retained for audit / debugging. */
  rawResponse: GroqVerboseTranscription;
  /** Model id actually used for this run. */
  model: string;
}

const DEFAULT_FILE_NAME = "lesson.mp3";

// Pull the audio bytes for the adapter. Kept private so we can swap to a
// streaming upload later without changing the public surface.
async function fetchAudioBlob(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Groq Whisper: failed to download audio (${response.status} ${response.statusText})`,
    );
  }
  return response.blob();
}

export async function transcribeAudioWithGroq(
  input: TranscribeAudioInput,
): Promise<TranscribeAudioResult> {
  const client = getGroqClient();
  const model = input.model ?? GROQ_WHISPER_MODEL;
  const audio = await fetchAudioBlob(input.audioUrl);
  const file = await toFile(audio, input.fileName ?? DEFAULT_FILE_NAME);

  // Groq's typings declare a flat `{ text }` response; the verbose payload is
  // delivered at runtime when response_format=verbose_json. Cast through
  // `unknown` and validate with zod so a future schema change fails loudly.
  const raw = (await client.audio.transcriptions.create({
    file,
    model,
    language: input.language,
    response_format: "verbose_json",
    timestamp_granularities: ["segment", "word"],
    ...(input.prompt ? { prompt: input.prompt } : {}),
  })) as unknown;

  const parsedRaw = GroqVerboseTranscriptionSchema.parse(raw);
  const transcript = mapGroqVerboseToTranscript(parsedRaw, {
    sourceId: input.sourceId,
    language: input.language,
    model,
  });

  return { transcript, rawResponse: parsedRaw, model };
}

export interface MapGroqVerboseToTranscriptOptions {
  sourceId: string;
  language: string;
  model: string;
  /** Override the createdAt timestamp; used by tests for determinism. */
  createdAt?: string;
}

// Pure transform from Groq's verbose_json into our domain transcript. Kept
// pure so the persistence layer (and tests) can drive it from a fixture
// without making a network call.
export function mapGroqVerboseToTranscript(
  raw: GroqVerboseTranscription,
  opts: MapGroqVerboseToTranscriptOptions,
): Transcript {
  const language = raw.language ?? opts.language;
  const wordsBySegmentIdx = bucketWordsToSegments(raw);

  const segments: TranscriptSegment[] = (raw.segments ?? []).map((seg, idx) => {
    const text = seg.text.trim();
    const words = wordsBySegmentIdx.get(idx) ?? [];
    return {
      id: `${opts.sourceId}:seg-${idx}`,
      // Whisper has no concept of speakers; diarization fills these in later.
      speaker: "unknown" as const,
      text: text.length > 0 ? text : "…",
      start: seg.start,
      end: Math.max(seg.end, seg.start),
      ...(words.length > 0 ? { words } : {}),
      language,
    };
  });

  const durationSec = raw.duration ?? deriveDuration(segments, raw);

  const transcript = {
    schemaVersion: SCHEMA_VERSIONS.transcript,
    sourceId: opts.sourceId,
    language,
    durationSec,
    provider: GROQ_WHISPER_PROVIDER_ID,
    model: opts.model,
    segments,
    createdAt: opts.createdAt ?? new Date().toISOString(),
  };

  return TranscriptSchema.parse(transcript);
}

// Map each top-level word to the segment whose [start, end] contains it. Groq
// returns word timestamps as a flat list when granularities include "word",
// not nested under segments, so we bucket them here.
function bucketWordsToSegments(raw: GroqVerboseTranscription): Map<number, WordTimestamp[]> {
  const buckets = new Map<number, WordTimestamp[]>();
  if (!raw.segments || raw.segments.length === 0) return buckets;

  // Some Groq responses ship words nested in each segment instead of flat at
  // the top level. Prefer the nested list when present.
  const hasNested = raw.segments.some((s) => Array.isArray(s.words) && s.words.length > 0);
  if (hasNested) {
    raw.segments.forEach((seg, idx) => {
      if (!seg.words || seg.words.length === 0) return;
      buckets.set(idx, seg.words.map(toDomainWord).filter(isNonEmptyWord));
    });
    return buckets;
  }

  if (!raw.words || raw.words.length === 0) return buckets;

  // For each word, find the segment that brackets its start time. Words that
  // do not match any segment are dropped rather than smeared across boundaries.
  for (const word of raw.words) {
    const idx = raw.segments.findIndex((s) => s.start <= word.start && word.start <= s.end);
    if (idx === -1) continue;
    const mapped = toDomainWord(word);
    if (!isNonEmptyWord(mapped)) continue;
    const arr = buckets.get(idx) ?? [];
    arr.push(mapped);
    buckets.set(idx, arr);
  }
  return buckets;
}

function toDomainWord(w: { word: string; start: number; end: number }): WordTimestamp {
  return {
    word: w.word.trim(),
    start: w.start,
    end: Math.max(w.end, w.start),
  };
}

function isNonEmptyWord(w: WordTimestamp): boolean {
  return w.word.length > 0;
}

function deriveDuration(segments: TranscriptSegment[], raw: GroqVerboseTranscription): number {
  const fromSegments = segments.length > 0 ? segments[segments.length - 1]!.end : 0;
  const fromWords = raw.words && raw.words.length > 0 ? raw.words[raw.words.length - 1]!.end : 0;
  return Math.max(fromSegments, fromWords, 0);
}
