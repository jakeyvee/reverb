import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Tables } from "@reverb/db/types";
import { SpeakerLabelSchema, type SpeakerLabel } from "@reverb/domain/schemas/speaker";

// VOL-128: Listening comprehension generator + loader.
//
// Listening items pull a 5–15s lesson snippet from materialized
// `dialogue_clips` rows and ask the user one of three question types:
//
//   1. transcription      — type what you hear, graded against caption.
//   2. mc_english         — pick the English meaning from 3 choices.
//   3. speaker_id         — name the speaker from teacher / student labels.
//
// The orchestrator slots these into the daily session as
// `practice_session_items.kind = 'dialogue_clip'` rows, with the chosen
// prompt persisted into the row's `metadata` jsonb so a refresh resumes the
// same question. Storage paths point at the private `lesson-clips` bucket
// and are signed at hydration time.

// Range policy. The issue calls out 5–15 second snippets; we allow shorter
// clips down to ~3s so the existing 1–8s dialogue clips remain usable (the
// generator is the only place that decides this so the bound is grep-able).
export const LISTENING_CLIP_MIN_DURATION_MS = 3_000;
export const LISTENING_CLIP_MAX_DURATION_MS = 16_000;

// Default cap on listening items per session. The orchestrator owns the
// final budget; this is the loader's safety net so a household with hundreds
// of clips doesn't drown vocab + drills out of the queue.
export const DEFAULT_LISTENING_LIMIT = 4;

export const LISTENING_PROMPT_KINDS = ["transcription", "mc_english", "speaker_id"] as const;
export const ListeningPromptKindSchema = z.enum(LISTENING_PROMPT_KINDS);
export type ListeningPromptKind = z.infer<typeof ListeningPromptKindSchema>;

// Speakers we ever surface to the user as a choice. `unknown` is excluded
// because it would make the speaker_id prompt unanswerable for the player —
// clips whose canonical speaker is `unknown` get a different prompt kind.
export const LISTENING_SPEAKER_CHOICES: ReadonlyArray<SpeakerLabel> = [
  "teacher",
  "student_vincent",
  "student_gf",
];

export const ListeningPromptSchema = z.object({
  kind: ListeningPromptKindSchema,
  question: z.string().min(1),
  choices: z.array(z.string().min(1)),
  // null when the prompt is free-text (transcription self-mark). Otherwise
  // a 0-based index into `choices`.
  answerIndex: z.number().int().nonnegative().nullable(),
  // Reference text used by transcription grading. Null for MC kinds.
  expectedText: z.string().min(1).nullable(),
});
export type ListeningPrompt = z.infer<typeof ListeningPromptSchema>;

// The `metadata` shape we persist on `practice_session_items`. Wrapped in
// `listening` so the column can carry orchestrator hints from other kinds
// without colliding.
export const ListeningItemMetadataSchema = z.object({
  listening: ListeningPromptSchema,
});
export type ListeningItemMetadata = z.infer<typeof ListeningItemMetadataSchema>;

// Decode whatever the DB returned in metadata back into a typed prompt.
// Returns null when the row was written by an older generator or by an
// unrelated subsystem — caller decides whether to skip or backfill.
export function parseListeningPromptFromMetadata(
  metadata: Tables<"practice_session_items">["metadata"],
): ListeningPrompt | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const parsed = ListeningItemMetadataSchema.safeParse(metadata);
  if (!parsed.success) return null;
  return parsed.data.listening;
}

export type ListeningClipCandidate = {
  clipId: string;
  lessonId: string;
  segmentId: string | null;
  caption: string | null;
  translation: string | null;
  speaker: SpeakerLabel | null;
  durationMs: number;
  storageBucket: string;
  storagePath: string;
};

// Hydrated view returned to the session runner.
export type ListeningItemView = {
  clipId: string;
  lessonId: string;
  lessonTitle: string | null;
  audioUrl: string | null;
  durationMs: number;
  prompt: ListeningPrompt;
};

type DialogueClipRow = Pick<
  Tables<"dialogue_clips">,
  | "id"
  | "lesson_id"
  | "segment_id"
  | "start_ms"
  | "end_ms"
  | "storage_bucket"
  | "storage_path"
  | "caption"
  | "translation"
  | "metadata"
> & {
  transcript_segment?: Pick<Tables<"transcript_segments">, "speaker"> | null;
};

// Loads materialized dialogue clips that are usable as listening items.
// Filters:
//   * audio is uploaded (metadata.materialization.materialized_at is set);
//   * the slice falls inside the listening-mode duration band;
//   * at least one of caption / translation / speaker is present so we can
//     build a prompt of some kind.
export async function loadListeningClipCandidates(
  supabase: SupabaseClient<Database>,
  args: { limit?: number; lessonId?: string } = {},
): Promise<ListeningClipCandidate[]> {
  const limit = args.limit ?? DEFAULT_LISTENING_LIMIT * 4;
  let query = supabase
    .from("dialogue_clips")
    .select(
      "id, lesson_id, segment_id, start_ms, end_ms, storage_bucket, storage_path, caption, translation, metadata, transcript_segment:transcript_segments!dialogue_clips_segment_id_fkey(speaker)",
    )
    .order("created_at", { ascending: false })
    .limit(limit);
  if (args.lessonId) query = query.eq("lesson_id", args.lessonId);

  const { data, error } = await query;
  if (error) {
    throw new Error(`Could not load dialogue_clips: ${error.message}`);
  }

  const rows = (data ?? []) as DialogueClipRow[];
  const candidates: ListeningClipCandidate[] = [];
  for (const row of rows) {
    if (!isMaterialized(row.metadata)) continue;
    const durationMs = row.end_ms - row.start_ms;
    if (
      durationMs < LISTENING_CLIP_MIN_DURATION_MS ||
      durationMs > LISTENING_CLIP_MAX_DURATION_MS
    ) {
      continue;
    }
    const speakerRaw = Array.isArray(row.transcript_segment)
      ? row.transcript_segment[0]?.speaker
      : row.transcript_segment?.speaker;
    const speakerParse = SpeakerLabelSchema.safeParse(speakerRaw);
    const speaker = speakerParse.success ? speakerParse.data : null;

    const hasCaption = (row.caption ?? "").trim().length > 0;
    const hasTranslation = (row.translation ?? "").trim().length > 0;
    const hasUsableSpeaker = speaker !== null && speaker !== "unknown";
    if (!hasCaption && !hasTranslation && !hasUsableSpeaker) continue;

    candidates.push({
      clipId: row.id,
      lessonId: row.lesson_id,
      segmentId: row.segment_id,
      caption: hasCaption ? row.caption!.trim() : null,
      translation: hasTranslation ? row.translation!.trim() : null,
      speaker,
      durationMs,
      storageBucket: row.storage_bucket,
      storagePath: row.storage_path,
    });
  }
  return candidates;
}

function isMaterialized(metadata: DialogueClipRow["metadata"]): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const materialization = (metadata as Record<string, unknown>).materialization;
  if (!materialization || typeof materialization !== "object" || Array.isArray(materialization)) {
    return false;
  }
  const at = (materialization as Record<string, unknown>).materialized_at;
  return typeof at === "string" && at.length > 0;
}

// Pure function: given a clip and its sibling pool, produce a prompt.
// Returns null if the clip lacks the data needed for the requested kind
// (caller can try a different kind, or drop the clip).
export function buildListeningPrompt(args: {
  kind: ListeningPromptKind;
  clip: ListeningClipCandidate;
  pool: ReadonlyArray<ListeningClipCandidate>;
}): ListeningPrompt | null {
  const { kind, clip, pool } = args;
  switch (kind) {
    case "transcription":
      if (!clip.caption) return null;
      return {
        kind: "transcription",
        question: "Type what the speaker said.",
        choices: [],
        answerIndex: null,
        expectedText: clip.caption,
      };
    case "mc_english":
      return buildMcEnglishPrompt(clip, pool);
    case "speaker_id":
      return buildSpeakerIdPrompt(clip);
  }
}

function buildMcEnglishPrompt(
  clip: ListeningClipCandidate,
  pool: ReadonlyArray<ListeningClipCandidate>,
): ListeningPrompt | null {
  if (!clip.translation) return null;
  const seen = new Set<string>([normalizeChoice(clip.translation)]);
  const distractors: string[] = [];
  // Walk the pool in deterministic order — caller controls ordering.
  for (const other of pool) {
    if (other.clipId === clip.clipId) continue;
    if (!other.translation) continue;
    const norm = normalizeChoice(other.translation);
    if (seen.has(norm)) continue;
    seen.add(norm);
    distractors.push(other.translation.trim());
    if (distractors.length >= 2) break;
  }
  // Pad with deterministic generic distractors when the household pool is
  // too thin. Keeps the MVP usable on day one (only one or two clips
  // available) without shipping a richer paraphrase generator.
  for (const fallback of DETERMINISTIC_FALLBACK_TRANSLATIONS) {
    if (distractors.length >= 2) break;
    const norm = normalizeChoice(fallback);
    if (seen.has(norm)) continue;
    seen.add(norm);
    distractors.push(fallback);
  }
  const choices = [clip.translation.trim(), ...distractors];
  const order = deterministicShuffle(choices, `${clip.clipId}:mc`);
  const answerIndex = order.indexOf(clip.translation.trim());
  if (answerIndex < 0) return null;
  return {
    kind: "mc_english",
    question: "Which English meaning matches what the speaker said?",
    choices: order,
    answerIndex,
    expectedText: null,
  };
}

function buildSpeakerIdPrompt(clip: ListeningClipCandidate): ListeningPrompt | null {
  if (!clip.speaker || clip.speaker === "unknown") return null;
  const choices = [...LISTENING_SPEAKER_CHOICES];
  // The choice strings stay machine-readable (the same SpeakerLabel
  // tokens). The UI formats them for display.
  const order = deterministicShuffle(choices, `${clip.clipId}:speaker`);
  const answerIndex = order.indexOf(clip.speaker);
  if (answerIndex < 0) return null;
  return {
    kind: "speaker_id",
    question: "Who is speaking in this clip?",
    choices: order as string[],
    answerIndex,
    expectedText: null,
  };
}

// Decide which prompt to attach to each clip. Walks the kinds in a fixed
// rotation so a session with three clips covers all three modes; if a clip
// can't satisfy its assigned kind (e.g. missing translation for mc_english)
// we fall back through the remaining kinds before giving up on the clip.
export function assignListeningPrompts(
  candidates: ReadonlyArray<ListeningClipCandidate>,
  options: { limit?: number; rotation?: ReadonlyArray<ListeningPromptKind> } = {},
): Array<{ clip: ListeningClipCandidate; prompt: ListeningPrompt }> {
  const rotation = options.rotation ?? LISTENING_PROMPT_KINDS;
  const limit = options.limit ?? DEFAULT_LISTENING_LIMIT;
  const out: Array<{ clip: ListeningClipCandidate; prompt: ListeningPrompt }> = [];
  let rotationIdx = 0;
  for (const clip of candidates) {
    if (out.length >= limit) break;
    const primary = rotation[rotationIdx % rotation.length]!;
    const order: ListeningPromptKind[] = [primary, ...rotation.filter((k) => k !== primary)];
    let prompt: ListeningPrompt | null = null;
    for (const kind of order) {
      prompt = buildListeningPrompt({ kind, clip, pool: candidates });
      if (prompt) break;
    }
    if (!prompt) continue;
    out.push({ clip, prompt });
    rotationIdx += 1;
  }
  return out;
}

// Self-mark grading for transcription answers. Compares case-folded,
// punctuation-stripped, whitespace-normalised forms. Returns "pass" if the
// player typed the canonical caption, "fail" otherwise. Callers can layer a
// "close enough" override on top via the self-mark path.
export function gradeListeningTranscription(args: {
  expected: string;
  actual: string;
}): "pass" | "fail" {
  return normalizeForGrading(args.expected) === normalizeForGrading(args.actual) ? "pass" : "fail";
}

function normalizeForGrading(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeChoice(value: string): string {
  return value.trim().toLowerCase();
}

// Lightweight string-hash → deterministic shuffle. Same seed always
// produces the same ordering, which keeps tests stable and lets a refresh
// re-derive the answer index from the persisted choices alone.
function deterministicShuffle<T>(items: ReadonlyArray<T>, seed: string): T[] {
  const out = [...items];
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let state = h >>> 0 || 1;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

// Generic English distractors used only when the household pool is too
// small to yield two real distractors. Kept short + concrete so they read
// plausibly in MC mode without bleeding domain meaning.
const DETERMINISTIC_FALLBACK_TRANSLATIONS = [
  "I don't understand.",
  "Can you say that again?",
  "It's nice to meet you.",
  "Where is the bathroom?",
  "I'll have one coffee, please.",
];

// Format the choice labels for the speaker_id mode. The persisted choices
// are machine-readable tokens; the UI runs them through this helper for
// display.
export function formatSpeakerChoice(token: string): string {
  switch (token) {
    case "teacher":
      return "Teacher";
    case "student_vincent":
      return "Vincent";
    case "student_gf":
      return "Vincent's partner";
    case "unknown":
      return "Unknown speaker";
    default:
      return token;
  }
}
