import {
  DEFAULT_INDONESIAN_VOICE,
  DIARIZATION_PROMPT_VERSION,
  EXTRACTION_RUN_KINDS,
  GOOGLE_TTS_PROVIDER_ID,
  INDONESIAN_LANGUAGE_CODE,
} from "@reverb/ai";
import type { Json, TablesInsert } from "@reverb/db/types";
import { generateVocabAudioForLesson } from "./tts.js";
import type {
  DiarizationOutput,
  DiarizationSegmentLabel,
  ExtractionOutput,
  SpeakerLabel,
  Transcript,
} from "@reverb/domain";
import { normalizeLemma, normalizeReading, vocabDedupeKey } from "@reverb/domain";
import { LESSON_CLIPS_BUCKET, dialogueClipPath } from "@reverb/media";
import type { JobRow, ServiceClient, SourceAudio } from "./state.js";
import { isStageCompleted, markStageCompleted } from "./state.js";
import type { PipelineLogger } from "./logger.js";
import type { PipelineServices } from "./services.js";
import { materializeDialogueClips } from "./clip-generation.js";
import { WORKER_STAGES, type WorkerStage } from "./types.js";

// Each stage handler is the seam where the real provider integration lives.
// For VOL-110 the transcribing stage is implemented end-to-end against Groq
// Whisper; later issues fill in the remaining placeholders.
//
// Contract every step must follow:
//   1. Short-circuit if `provider_metadata.stages.<stage>` is already set.
//   2. Writes to product tables (transcript_segments, transcript_words, etc.)
//      must be safely re-runnable — either upsert on a stable natural key, or
//      delete-then-insert keyed on `lesson_id` so a retry replaces the prior
//      attempt's output rather than duplicating it.
//   3. Return a small `details` payload that gets stored alongside the
//      completion marker; the UI doesn't depend on its shape today but having
//      it makes per-step debugging trivial.

export type StepContext = {
  supabase: ServiceClient;
  job: JobRow;
  source: SourceAudio;
  services: PipelineServices;
  logger: PipelineLogger;
};

export type StepResult = {
  // Optional structured metadata to persist alongside the stage completion.
  details?: Record<string, unknown>;
};

export type StepHandler = (ctx: StepContext) => Promise<StepResult>;

// MVP defaults to Bahasa Indonesia. The lessons row will eventually carry an
// explicit `source_language` and the worker should prefer that; until then the
// product targets Indonesian only.
const DEFAULT_LANGUAGE = "id";

async function transcribingStep(ctx: StepContext): Promise<StepResult> {
  const { supabase, source, services, logger, job } = ctx;
  const language = DEFAULT_LANGUAGE;
  logger.info("Calling Groq Whisper", {
    lessonId: job.lesson_id,
    bytes: source.byteSize,
    durationMs: source.durationMs,
    language,
  });

  const { transcript, rawResponse, model } = await services.transcribe({
    audioUrl: source.signedUrl,
    language,
    sourceId: job.lesson_id,
    fileName: defaultFileNameFromPath(source.storagePath),
  });

  const persisted = await persistTranscript(supabase, job.lesson_id, transcript);
  logger.info("Persisted transcript", {
    lessonId: job.lesson_id,
    segmentCount: persisted.segmentCount,
    wordCount: persisted.wordCount,
  });

  // Raw provider payload is kept on the job row's provider_metadata so we can
  // diff against a future re-run or debug a parse failure without re-fetching
  // the audio. The normalized rows in transcript_segments/transcript_words
  // remain the source of truth for app-facing reads.
  return {
    details: {
      provider: transcript.provider,
      model,
      language: transcript.language,
      duration_sec: transcript.durationSec,
      segment_count: persisted.segmentCount,
      word_count: persisted.wordCount,
      raw_response: rawResponse as unknown,
    },
  };
}

function defaultFileNameFromPath(storagePath: string): string {
  const segments = storagePath.split("/");
  return segments[segments.length - 1] ?? "lesson.audio";
}

export type PersistTranscriptResult = {
  segmentCount: number;
  wordCount: number;
};

// Replaces all transcript_segments / transcript_words rows for a lesson with
// the ones produced by `transcript`. The schema's cascade-on-delete from
// segments → words means a single delete cleans both tables; we then bulk-
// insert the new rows. The write is keyed on `lesson_id` so a retry of the
// same stage is idempotent at the table level even if the previous attempt
// got partway through.
export async function persistTranscript(
  supabase: ServiceClient,
  lessonId: string,
  transcript: Transcript,
): Promise<PersistTranscriptResult> {
  const { error: deleteError } = await supabase
    .from("transcript_segments")
    .delete()
    .eq("lesson_id", lessonId);
  if (deleteError) {
    throw new Error(
      `Could not clear transcript_segments for lesson ${lessonId}: ${deleteError.message}`,
    );
  }

  if (transcript.segments.length === 0) {
    return { segmentCount: 0, wordCount: 0 };
  }

  const segmentRows = transcript.segments.map((seg, idx) => ({
    lesson_id: lessonId,
    segment_index: idx,
    start_ms: toMs(seg.start),
    end_ms: toMs(seg.end),
    text: seg.text,
    speaker: null,
    language: seg.language ?? transcript.language,
    metadata: {
      provider_segment_id: seg.id,
      ...(typeof seg.confidence === "number" ? { confidence: seg.confidence } : {}),
    },
  }));

  const { data: insertedSegments, error: insertError } = await supabase
    .from("transcript_segments")
    .insert(segmentRows)
    .select("id, segment_index");
  if (insertError || !insertedSegments) {
    throw new Error(
      `Could not insert transcript_segments for lesson ${lessonId}: ${insertError?.message ?? "no rows returned"}`,
    );
  }

  const segmentIdByIndex = new Map<number, string>();
  for (const row of insertedSegments) {
    segmentIdByIndex.set(row.segment_index, row.id);
  }

  const wordRows = transcript.segments.flatMap((seg, segIdx) => {
    const segmentId = segmentIdByIndex.get(segIdx);
    if (!segmentId || !seg.words) return [];
    return seg.words.map((word, wordIdx) => ({
      segment_id: segmentId,
      lesson_id: lessonId,
      word_index: wordIdx,
      start_ms: toMs(word.start),
      end_ms: toMs(word.end),
      text: word.word,
      confidence: typeof word.confidence === "number" ? word.confidence : null,
    }));
  });

  if (wordRows.length > 0) {
    const { error: wordsError } = await supabase.from("transcript_words").insert(wordRows);
    if (wordsError) {
      throw new Error(
        `Could not insert transcript_words for lesson ${lessonId}: ${wordsError.message}`,
      );
    }
  }

  return { segmentCount: segmentRows.length, wordCount: wordRows.length };
}

function toMs(sec: number): number {
  return Math.round(sec * 1000);
}

async function diarizingStep(ctx: StepContext): Promise<StepResult> {
  const { supabase, services, logger, job } = ctx;

  const segments = await loadSegmentsForDiarization(supabase, job.lesson_id);
  if (segments.length === 0) {
    logger.info("Diarization skipped — no transcript segments to label", {
      lessonId: job.lesson_id,
    });
    return {
      details: {
        provider: "noop",
        prompt_version: DIARIZATION_PROMPT_VERSION,
        segment_count: 0,
        labeled_count: 0,
        unknown_count: 0,
        low_priority_count: 0,
      },
    };
  }

  // We send the LLM a stable index-based id (S0, S1, …) and map back to the
  // database UUID locally. The prompt never sees row uuids, which keeps the
  // log payload short and the tokens cheap.
  const idByPromptId = new Map<string, string>();
  const inputSegments = segments.map((seg) => {
    const promptId = `S${seg.segment_index}`;
    idByPromptId.set(promptId, seg.id);
    return {
      id: promptId,
      text: seg.text,
      startSec: seg.start_ms / 1000,
      endSec: seg.end_ms / 1000,
      ...(seg.language ? { language: seg.language } : {}),
    };
  });

  const language = pickInputLanguage(segments);

  logger.info("Calling Anthropic diarization", {
    lessonId: job.lesson_id,
    segmentCount: inputSegments.length,
    language,
  });

  const { diarization, model, promptVersion, rawResponse } = await services.diarize({
    sourceTranscriptId: job.lesson_id,
    language,
    segments: inputSegments,
  });

  const labelByDbId = mapLabelsToSegmentIds(diarization, idByPromptId);
  const persistResult = await persistDiarizationLabels(supabase, segments, labelByDbId);

  logger.info("Persisted diarization labels", {
    lessonId: job.lesson_id,
    labeled: persistResult.labeledCount,
    unknown: persistResult.unknownCount,
    lowPriority: persistResult.lowPriorityCount,
    missing: persistResult.missingCount,
  });

  return {
    details: {
      provider: "anthropic-diarization",
      model,
      prompt_version: promptVersion,
      schema_version: diarization.schemaVersion,
      segment_count: segments.length,
      labeled_count: persistResult.labeledCount,
      unknown_count: persistResult.unknownCount,
      low_priority_count: persistResult.lowPriorityCount,
      // Segments the LLM did not return — we leave their speaker as null so
      // the UI / extraction can tell apart "didn't know yet" from "labeled
      // unknown deliberately". Captured here for audit.
      missing_count: persistResult.missingCount,
      raw_response: rawResponse,
    },
  };
}

type SegmentForDiarization = {
  id: string;
  segment_index: number;
  text: string;
  start_ms: number;
  end_ms: number;
  language: string | null;
};

type SegmentForExtraction = SegmentForDiarization & {
  speaker: string | null;
  speaker_low_priority: boolean | null;
};

type LessonForExtraction = {
  id: string;
  household_id: string;
  source_language: string | null;
};

async function loadSegmentsForDiarization(
  supabase: ServiceClient,
  lessonId: string,
): Promise<SegmentForDiarization[]> {
  const { data, error } = await supabase
    .from("transcript_segments")
    .select("id, segment_index, text, start_ms, end_ms, language")
    .eq("lesson_id", lessonId)
    .order("segment_index", { ascending: true });
  if (error) {
    throw new Error(`Could not load transcript_segments for diarization: ${error.message}`);
  }
  return (data ?? []) as SegmentForDiarization[];
}

function pickInputLanguage(segments: SegmentForDiarization[]): string {
  // Pick the first non-null language hint we have. Whisper sets the same
  // language on every segment so there is no need to vote — but defensively
  // fall back to the pipeline default when the field is empty.
  for (const seg of segments) {
    if (seg.language) return seg.language;
  }
  return DEFAULT_LANGUAGE;
}

async function loadLessonForExtraction(
  supabase: ServiceClient,
  lessonId: string,
): Promise<LessonForExtraction> {
  const { data, error } = await supabase
    .from("lessons")
    .select("id, household_id, source_language")
    .eq("id", lessonId)
    .maybeSingle();
  if (error || !data) {
    throw new Error(
      `Could not load lesson ${lessonId} for extraction: ${error?.message ?? "not found"}`,
    );
  }
  return data as LessonForExtraction;
}

async function loadSegmentsForExtraction(
  supabase: ServiceClient,
  lessonId: string,
): Promise<SegmentForExtraction[]> {
  const { data, error } = await supabase
    .from("transcript_segments")
    .select("id, segment_index, text, start_ms, end_ms, language, speaker, speaker_low_priority")
    .eq("lesson_id", lessonId)
    .order("segment_index", { ascending: true });
  if (error) {
    throw new Error(`Could not load transcript_segments for extraction: ${error.message}`);
  }
  return (data ?? []) as SegmentForExtraction[];
}

function buildExtractionPromptSegments(segments: SegmentForExtraction[]): Array<{
  id: string;
  text: string;
  startSec: number;
  endSec: number;
  language?: string;
  speaker: SpeakerLabel;
  lowPriority: boolean;
}> {
  return segments.map((seg) => ({
    id: promptSegmentId(seg),
    text: seg.text,
    startSec: seg.start_ms / 1000,
    endSec: seg.end_ms / 1000,
    ...(seg.language ? { language: seg.language } : {}),
    speaker: normalizeSpeaker(seg.speaker),
    lowPriority: Boolean(seg.speaker_low_priority),
  }));
}

type PreparedVocab = {
  key: string;
  source: ExtractionOutput["new_vocab"][number];
  segmentIds: string[];
  row: TablesInsert<"vocab_items">;
};

type ExtractionDerivedWrites = {
  vocab: PreparedVocab[];
  grammar: Array<TablesInsert<"grammar_patterns">>;
  dialogue: Array<TablesInsert<"dialogue_clips">>;
  corrections: Array<TablesInsert<"teacher_corrections">>;
  runs: Array<TablesInsert<"extraction_runs">>;
};

function buildExtractionWrites(args: {
  lesson: LessonForExtraction;
  segments: SegmentForExtraction[];
  extraction: ExtractionOutput;
  model: string;
  promptVersion: string;
  extractedAt: string;
  // Monotonically increasing per-(lesson, kind). The first ever extraction
  // writes version 1; each reprocess bumps every kind's run by one so
  // historical runs stay queryable side-by-side without a unique-index
  // collision.
  runVersion: number;
}): ExtractionDerivedWrites {
  const promptById = new Map(args.segments.map((segment) => [promptSegmentId(segment), segment]));
  const vocab = uniqueBy(
    args.extraction.new_vocab.map((item) => buildPreparedVocab(args, item, promptById)),
    (entry) => entry.key,
  );
  const grammar = uniqueBy(
    args.extraction.grammar_patterns.map((item) => buildGrammarRow(args, item, promptById)),
    (row) => `${String(row.pattern).toLowerCase()}|${JSON.stringify(row.examples)}`,
  );
  const dialogue = uniqueBy(
    args.extraction.dialogue_clips.map((item) => buildDialogueRow(args, item, promptById)),
    (row) => String(row.id),
  );
  const corrections = uniqueBy(
    args.extraction.teacher_corrections.map((item) => buildCorrectionRow(args, item, promptById)),
    (row) =>
      `${String(row.lesson_id)}|${String(row.kind)}|${String(row.source_text)}|${String(row.corrected_text)}`,
  );

  const input = {
    sourceTranscriptId: args.extraction.sourceTranscriptId,
    language: args.extraction.language,
    segmentCount: args.segments.length,
    segmentIds: args.segments.map((segment) => segment.id),
  };

  const runs = EXTRACTION_RUN_KINDS.map((kind) => ({
    lesson_id: args.lesson.id,
    kind,
    status: "succeeded" as const,
    model: args.model,
    prompt_version: args.promptVersion,
    input: input as Json,
    output: extractionOutputForKind(args.extraction, kind),
    error: null,
    cost_cents: null,
    started_at: args.extractedAt,
    finished_at: args.extractedAt,
    version: args.runVersion,
    superseded_at: null,
  })) satisfies Array<TablesInsert<"extraction_runs">>;

  return { vocab, grammar, dialogue, corrections, runs };
}

// Reset the lesson-owned extraction outputs before re-running the step.
// Two design notes:
//
//   - `grammar_patterns` and `dialogue_clips` have no per-user state hanging
//     off them, so a plain delete-then-insert keeps the table aligned with
//     the latest run's output without harming anything.
//
//   - `teacher_corrections` and `extraction_runs` are NOT wiped here.
//     teacher_corrections cascade-deletes `correction_drills` (per-user
//     FSRS-like state), so we instead upsert on the (lesson, kind,
//     source_text, corrected_text) unique index and let identical
//     corrections reuse their existing row — preserving the partner's
//     practice progress when a reprocess re-emits the same correction.
//     extraction_runs becomes an append-only audit log keyed on `version`
//     so re-runs can diff prompt revisions side-by-side; the prior runs
//     are marked `superseded_at` rather than dropped.
//
// `vocab_items` is intentionally excluded — vocab dedupe + the
// (household_id, lower(lemma), coalesce(reading, '')) unique index already
// keeps cards (and any FSRS history) stable across runs.
async function clearLessonOwnedExtractionRows(
  supabase: ServiceClient,
  lessonId: string,
): Promise<void> {
  const tables = ["grammar_patterns", "dialogue_clips"] as const;
  for (const table of tables) {
    const { error } = await supabase.from(table).delete().eq("lesson_id", lessonId);
    if (error) {
      throw new Error(`Could not clear ${table} for lesson ${lessonId}: ${error.message}`);
    }
  }
}

// Stamp every prior extraction_runs row for this lesson as superseded. Called
// just before inserting the new run rows so the version transition is atomic
// from the reader's perspective: a query for `superseded_at is null` always
// returns exactly one set of (kind, version) rows after this completes.
async function markPriorExtractionRunsSuperseded(
  supabase: ServiceClient,
  lessonId: string,
  supersededAt: string,
): Promise<void> {
  const { error } = await supabase
    .from("extraction_runs")
    .update({ superseded_at: supersededAt })
    .eq("lesson_id", lessonId)
    .is("superseded_at", null);
  if (error) {
    throw new Error(
      `Could not mark prior extraction_runs as superseded for lesson ${lessonId}: ${error.message}`,
    );
  }
}

// Look up the next version number to use for this lesson's extraction_runs.
// Returns 1 if the lesson has never been extracted before. Includes
// superseded rows so versions stay monotonically increasing even across
// reprocesses — readers can read the history by ordering on `version desc`.
async function nextExtractionRunVersion(
  supabase: ServiceClient,
  lessonId: string,
): Promise<number> {
  const { data, error } = await supabase
    .from("extraction_runs")
    .select("version")
    .eq("lesson_id", lessonId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(
      `Could not read max extraction_runs.version for lesson ${lessonId}: ${error.message}`,
    );
  }
  const current = typeof data?.version === "number" ? data.version : 0;
  return current + 1;
}

async function persistLessonOwnedRows(
  supabase: ServiceClient,
  writes: Pick<ExtractionDerivedWrites, "grammar" | "dialogue" | "corrections" | "runs">,
): Promise<void> {
  await insertRows(supabase, "grammar_patterns", writes.grammar);
  await insertRows(supabase, "dialogue_clips", writes.dialogue);
  // Upsert on the natural key so re-emitted corrections reuse the existing
  // row id — keeping each user's correction_drills FK intact. New
  // corrections fall through to insert; rewritten ones land in `update`
  // (which is fine: the source_text + corrected_text are part of the key,
  // so the only fields that actually change are explanation / metadata /
  // confidence). `ignoreDuplicates: false` is the default but called out
  // explicitly to make the intent obvious.
  await upsertCorrections(supabase, writes.corrections);
  await insertRows(supabase, "extraction_runs", writes.runs);
}

async function upsertCorrections(
  supabase: ServiceClient,
  rows: Array<TablesInsert<"teacher_corrections">>,
): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await supabase.from("teacher_corrections").upsert(rows, {
    onConflict: "lesson_id,kind,source_text,corrected_text",
    ignoreDuplicates: false,
  });
  if (error) {
    throw new Error(`Could not upsert teacher_corrections: ${error.message}`);
  }
}

async function insertRows(
  supabase: ServiceClient,
  table: "grammar_patterns",
  rows: Array<TablesInsert<"grammar_patterns">>,
): Promise<void>;
async function insertRows(
  supabase: ServiceClient,
  table: "dialogue_clips",
  rows: Array<TablesInsert<"dialogue_clips">>,
): Promise<void>;
async function insertRows(
  supabase: ServiceClient,
  table: "extraction_runs",
  rows: Array<TablesInsert<"extraction_runs">>,
): Promise<void>;
async function insertRows(
  supabase: ServiceClient,
  table: "grammar_patterns" | "dialogue_clips" | "extraction_runs",
  rows:
    | Array<TablesInsert<"grammar_patterns">>
    | Array<TablesInsert<"dialogue_clips">>
    | Array<TablesInsert<"extraction_runs">>,
): Promise<void> {
  if (rows.length === 0) return;
  const { error } = await supabase.from(table).insert(rows as never);
  if (error) {
    throw new Error(`Could not persist ${table}: ${error.message}`);
  }
}

type ExistingVocabRow = {
  id: string;
  lemma: string;
  reading: string | null;
};

// Pull the household's existing vocab for the lemmas we're about to insert,
// so we can dedupe against it. Vocab is household-shared, so a word that
// appeared in an earlier lesson must reuse the same row — both to satisfy
// the unique index on (household_id, lower(lemma), coalesce(reading, ''))
// and to keep any cards already attached to that vocab_item stable across
// lessons.
//
// The query is restricted to the prepared lemmas (rather than the household's
// entire vocab) so request size scales with the new extraction, not with the
// household's lifetime vocab — PostgREST caps unbounded selects at 1000 rows,
// which would silently miss older entries once a household crosses that
// threshold and trigger unique-index errors on the next insert.
async function loadHouseholdVocabIndex(
  supabase: ServiceClient,
  householdId: string,
  prepared: PreparedVocab[],
): Promise<Map<string, ExistingVocabRow>> {
  if (prepared.length === 0) return new Map();

  const preparedKeys = new Set(prepared.map((entry) => entry.key));
  const index = new Map<string, ExistingVocabRow>();
  const queriedLemmas = new Set<string>();

  for (const entry of prepared) {
    const lemma = entry.row.lemma as string;
    const lookupKey = lemma.toLocaleLowerCase();
    if (queriedLemmas.has(lookupKey)) continue;
    queriedLemmas.add(lookupKey);

    const { data, error } = await supabase
      .from("vocab_items")
      .select("id, lemma, reading")
      .eq("household_id", householdId)
      .ilike("lemma", escapeLikePattern(lemma));
    if (error) {
      throw new Error(`Could not load vocab_items for household ${householdId}: ${error.message}`);
    }

    for (const row of (data ?? []) as ExistingVocabRow[]) {
      const key = vocabDedupeKey({ lemma: row.lemma, reading: row.reading });
      if (preparedKeys.has(key)) {
        index.set(key, row);
      }
    }
  }
  return index;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

type ResolvedVocab = PreparedVocab & { vocabItemId: string; isNew: boolean };

// Inserts vocab rows the household has never seen and rewires the prepared
// entries so each one carries a final `vocabItemId`. Existing rows are
// reused as-is; we don't rewrite their lemma/reading/example so the original
// lesson's context survives, even when a later lesson re-extracts the same
// word.
async function reconcileVocab(
  supabase: ServiceClient,
  householdId: string,
  prepared: PreparedVocab[],
): Promise<ResolvedVocab[]> {
  if (prepared.length === 0) return [];

  const existing = await loadHouseholdVocabIndex(supabase, householdId, prepared);
  const resolved: ResolvedVocab[] = [];
  const toInsert: PreparedVocab[] = [];

  for (const entry of prepared) {
    const match = existing.get(entry.key);
    if (match) {
      resolved.push({ ...entry, vocabItemId: match.id, isNew: false });
    } else {
      toInsert.push(entry);
    }
  }

  if (toInsert.length === 0) return resolved;

  const insertRows = toInsert.map((entry) => entry.row) as TablesInsert<"vocab_items">[];
  const { data, error } = await supabase
    .from("vocab_items")
    .insert(insertRows)
    .select("id, lemma, reading");
  if (error || !data) {
    throw new Error(
      `Could not insert vocab_items for household ${householdId}: ${error?.message ?? "no rows returned"}`,
    );
  }

  const insertedIndex = new Map<string, string>();
  for (const row of data as ExistingVocabRow[]) {
    insertedIndex.set(vocabDedupeKey({ lemma: row.lemma, reading: row.reading }), row.id);
  }
  for (const entry of toInsert) {
    const id = insertedIndex.get(entry.key);
    if (!id) {
      throw new Error(`Inserted vocab_item missing for key ${entry.key}`);
    }
    resolved.push({ ...entry, vocabItemId: id, isNew: true });
  }
  return resolved;
}

async function loadHouseholdMemberIds(
  supabase: ServiceClient,
  householdId: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id")
    .eq("household_id", householdId);
  if (error) {
    throw new Error(`Could not load profiles for household ${householdId}: ${error.message}`);
  }
  return (data ?? []).map((row) => (row as { id: string }).id);
}

// Build the lookup that lets us skip a vocab_item for any user who has marked
// it known — either via the future "I already know this" UI or via seed
// fixtures that pre-populate user_known_words. The `(user_id, vocab_item_id)`
// pair is the dedupe key.
async function loadKnownWordPairs(
  supabase: ServiceClient,
  userIds: string[],
  vocabItemIds: string[],
): Promise<Set<string>> {
  if (userIds.length === 0 || vocabItemIds.length === 0) return new Set();

  const { data, error } = await supabase
    .from("user_known_words")
    .select("user_id, vocab_item_id")
    .in("user_id", userIds)
    .in("vocab_item_id", vocabItemIds);
  if (error) {
    throw new Error(`Could not load user_known_words: ${error.message}`);
  }
  const pairs = new Set<string>();
  for (const row of (data ?? []) as Array<{ user_id: string; vocab_item_id: string }>) {
    pairs.add(`${row.user_id}|${row.vocab_item_id}`);
  }
  return pairs;
}

function buildCardRows(args: {
  lesson: LessonForExtraction;
  resolvedVocab: ResolvedVocab[];
  userIds: string[];
  knownPairs: Set<string>;
  model: string;
  promptVersion: string;
}): TablesInsert<"cards">[] {
  const rows: TablesInsert<"cards">[] = [];
  for (const userId of args.userIds) {
    for (const entry of args.resolvedVocab) {
      if (args.knownPairs.has(`${userId}|${entry.vocabItemId}`)) continue;
      rows.push({
        user_id: userId,
        vocab_item_id: entry.vocabItemId,
        // Carry the lesson context the user first encountered the word in so
        // the review UI can show "from {lesson}" alongside the vocab card.
        // Idempotent inserts (`ignoreDuplicates`) preserve the original
        // metadata across retries, even if a later run reuses a different
        // example sentence.
        metadata: {
          source_lesson_id: args.lesson.id,
          source_transcript_id: args.lesson.id,
          source_segment_ids: entry.segmentIds,
          example_sentence: entry.source.example ?? null,
          example_translation: entry.source.exampleGloss ?? null,
          model: args.model,
          prompt_version: args.promptVersion,
        },
      });
    }
  }
  return rows;
}

async function persistCards(
  supabase: ServiceClient,
  rows: TablesInsert<"cards">[],
): Promise<number> {
  if (rows.length === 0) return 0;
  // unique (user_id, vocab_item_id) — `ignoreDuplicates` keeps the existing
  // card row and its FSRS state intact when an extraction retry re-emits the
  // same vocab.
  const { error } = await supabase
    .from("cards")
    .upsert(rows, { onConflict: "user_id,vocab_item_id", ignoreDuplicates: true });
  if (error) {
    throw new Error(`Could not upsert cards: ${error.message}`);
  }
  return rows.length;
}

function buildPreparedVocab(
  args: {
    lesson: LessonForExtraction;
    model: string;
    promptVersion: string;
  },
  item: ExtractionOutput["new_vocab"][number],
  promptById: Map<string, SegmentForExtraction>,
): PreparedVocab {
  const sourceSegments = resolveSourceSegments(
    item.sourceSegmentIds,
    promptById,
    `vocab item "${item.term}"`,
  );
  const lemma = normalizeLemma(item.term);
  const reading = normalizeReading(item.pronunciation);
  const segmentIds = sourceSegments.map((segment) => segment.id);
  return {
    key: vocabDedupeKey({ lemma, reading }),
    source: item,
    segmentIds,
    row: {
      household_id: args.lesson.household_id,
      lesson_id: args.lesson.id,
      lemma,
      reading,
      translation: item.gloss,
      part_of_speech: item.partOfSpeech ?? null,
      example_sentence: item.example ?? null,
      example_translation: item.exampleGloss ?? null,
      audio_storage_bucket: null,
      audio_storage_path: null,
      difficulty: difficultyScore(item.difficulty),
      metadata: extractionMetadata({
        model: args.model,
        promptVersion: args.promptVersion,
        sourceTranscriptId: args.lesson.id,
        sourceSegmentIds: segmentIds,
        kind: "vocab",
      }),
    },
  };
}

function buildGrammarRow(
  args: {
    lesson: LessonForExtraction;
    model: string;
    promptVersion: string;
  },
  item: ExtractionOutput["grammar_patterns"][number],
  promptById: Map<string, SegmentForExtraction>,
): TablesInsert<"grammar_patterns"> {
  const sourceSegments = resolveSourceSegments(
    item.sourceSegmentIds,
    promptById,
    `grammar pattern "${item.pattern}"`,
  );
  return {
    household_id: args.lesson.household_id,
    lesson_id: args.lesson.id,
    pattern: item.pattern,
    description: item.explanation,
    examples: item.examples,
    difficulty: difficultyScore(item.difficulty),
    metadata: extractionMetadata({
      model: args.model,
      promptVersion: args.promptVersion,
      sourceTranscriptId: args.lesson.id,
      sourceSegmentIds: sourceSegments.map((segment) => segment.id),
      kind: "grammar",
    }),
  };
}

function buildDialogueRow(
  args: {
    lesson: LessonForExtraction;
    model: string;
    promptVersion: string;
  },
  item: ExtractionOutput["dialogue_clips"][number],
  promptById: Map<string, SegmentForExtraction>,
): TablesInsert<"dialogue_clips"> {
  const start = resolvePromptSegment(
    item.startSegmentId,
    promptById,
    `dialogue clip "${item.id}" startSegmentId`,
  );
  const end = resolvePromptSegment(
    item.endSegmentId,
    promptById,
    `dialogue clip "${item.id}" endSegmentId`,
  );
  if (start.segment_index > end.segment_index) {
    throw new Error(
      `Dialogue clip "${item.id}" has startSegmentId ${item.startSegmentId} after endSegmentId ${item.endSegmentId}`,
    );
  }
  if (
    Math.abs(item.startSec - start.start_ms / 1000) > 0.01 ||
    Math.abs(item.endSec - end.end_ms / 1000) > 0.01
  ) {
    throw new Error(
      `Dialogue clip "${item.id}" does not mirror the transcript time range for ${item.startSegmentId}..${item.endSegmentId}`,
    );
  }

  return {
    id: item.id,
    household_id: args.lesson.household_id,
    lesson_id: args.lesson.id,
    segment_id: start.id,
    start_ms: start.start_ms,
    end_ms: end.end_ms,
    storage_bucket: LESSON_CLIPS_BUCKET,
    storage_path: dialogueClipPath({
      householdId: args.lesson.household_id,
      lessonId: args.lesson.id,
      clipId: item.id,
    }),
    caption: item.title,
    translation: item.description ?? null,
    metadata: extractionMetadata({
      model: args.model,
      promptVersion: args.promptVersion,
      sourceTranscriptId: args.lesson.id,
      sourceSegmentIds: sourceSegmentIdsInRange(promptById, start.segment_index, end.segment_index),
      kind: "dialogue",
      extra: {
        startSegmentId: item.startSegmentId,
        endSegmentId: item.endSegmentId,
        participants: item.participants,
        focus: item.focus ?? null,
      },
    }),
  };
}

function buildCorrectionRow(
  args: {
    lesson: LessonForExtraction;
    model: string;
    promptVersion: string;
  },
  item: ExtractionOutput["teacher_corrections"][number],
  promptById: Map<string, SegmentForExtraction>,
): TablesInsert<"teacher_corrections"> {
  const segment = resolvePromptSegment(
    item.segmentId,
    promptById,
    `teacher correction for "${item.utterance}"`,
  );
  return {
    household_id: args.lesson.household_id,
    lesson_id: args.lesson.id,
    segment_id: segment.id,
    kind: teacherCorrectionKind(item.category),
    source_text: item.utterance,
    corrected_text: item.correction,
    explanation: item.rationale ?? null,
    // `confidence` lands on the column (VOL-120 migration) so the session
    // selector can filter without re-parsing metadata. NULL means
    // "unscored" — older runs and any LLM response that omits the field.
    confidence: item.confidence ?? null,
    metadata: extractionMetadata({
      model: args.model,
      promptVersion: args.promptVersion,
      sourceTranscriptId: args.lesson.id,
      sourceSegmentIds: [segment.id],
      kind: "corrections",
      extra: {
        studentSpeaker: item.studentSpeaker,
        category: item.category,
        severity: item.severity ?? null,
        confidence: item.confidence ?? null,
      },
    }),
  };
}

function extractionOutputForKind(
  extraction: ExtractionOutput,
  kind: (typeof EXTRACTION_RUN_KINDS)[number],
): Json {
  switch (kind) {
    case "vocab":
      return { new_vocab: extraction.new_vocab };
    case "grammar":
      return { grammar_patterns: extraction.grammar_patterns };
    case "dialogue":
      return { dialogue_clips: extraction.dialogue_clips };
    case "corrections":
      return { teacher_corrections: extraction.teacher_corrections };
  }
}

function resolveSourceSegments(
  sourceSegmentIds: string[],
  promptById: Map<string, SegmentForExtraction>,
  label: string,
): SegmentForExtraction[] {
  if (sourceSegmentIds.length === 0) {
    throw new Error(`${label} must reference at least one transcript segment`);
  }

  return sourceSegmentIds.map((sourceSegmentId) =>
    resolvePromptSegment(sourceSegmentId, promptById, `${label} sourceSegmentIds`),
  );
}

function resolvePromptSegment(
  promptId: string,
  promptById: Map<string, SegmentForExtraction>,
  label: string,
): SegmentForExtraction {
  const segment = promptById.get(promptId);
  if (!segment) {
    throw new Error(`${label} references unknown transcript segment ${promptId}`);
  }
  return segment;
}

function sourceSegmentIdsInRange(
  promptById: Map<string, SegmentForExtraction>,
  startIndex: number,
  endIndex: number,
): string[] {
  const ids: string[] = [];
  for (const segment of promptById.values()) {
    if (segment.segment_index < startIndex || segment.segment_index > endIndex) continue;
    ids.push(segment.id);
  }
  return ids;
}

function extractionMetadata(args: {
  model: string;
  promptVersion: string;
  sourceTranscriptId: string;
  sourceSegmentIds: string[];
  kind: "vocab" | "grammar" | "dialogue" | "corrections";
  extra?: Record<string, unknown>;
}): Json {
  return {
    model: args.model,
    prompt_version: args.promptVersion,
    source_transcript_id: args.sourceTranscriptId,
    source_segment_ids: args.sourceSegmentIds,
    kind: args.kind,
    ...(args.extra ?? {}),
  };
}

function promptSegmentId(segment: SegmentForExtraction): string {
  return `S${segment.segment_index}`;
}

function normalizeSpeaker(speaker: string | null): SpeakerLabel {
  if (speaker === "teacher" || speaker === "student_vincent" || speaker === "student_gf") {
    return speaker;
  }
  return "unknown";
}

function difficultyScore(
  difficulty: ExtractionOutput["new_vocab"][number]["difficulty"],
): number | null {
  if (!difficulty) return null;
  switch (difficulty) {
    case "beginner":
      return 1;
    case "intermediate":
      return 2;
    case "advanced":
      return 3;
  }
}

function teacherCorrectionKind(
  category: ExtractionOutput["teacher_corrections"][number]["category"],
): "grammar" | "vocabulary" | "pronunciation" | "usage" {
  switch (category) {
    case "vocab":
      return "vocabulary";
    case "grammar":
    case "pronunciation":
    case "usage":
      return category;
    case "other":
      return "usage";
  }
}

function uniqueBy<T>(values: T[], keyFn: (value: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const value of values) {
    const key = keyFn(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

// Match each LLM-emitted label back to its database row. Labels for prompt
// ids we never sent (the model hallucinated an id) are dropped with a logged
// warning by the caller — they cannot affect persistence because they have
// no matching row.
function mapLabelsToSegmentIds(
  output: DiarizationOutput,
  idByPromptId: Map<string, string>,
): Map<string, DiarizationSegmentLabel> {
  const result = new Map<string, DiarizationSegmentLabel>();
  for (const label of output.segments) {
    const dbId = idByPromptId.get(label.segmentId);
    if (!dbId) continue;
    result.set(dbId, label);
  }
  return result;
}

export type PersistDiarizationResult = {
  labeledCount: number;
  unknownCount: number;
  lowPriorityCount: number;
  /** Segments the LLM did not return a label for; left as speaker=null. */
  missingCount: number;
};

// Update each transcript_segments row in place: speaker, confidence, notes,
// low_priority. The original ASR text is never touched — diarization is a
// labeling pass, not a rewrite. Segments missing from the LLM response are
// left untouched (speaker stays null) so a partial response cannot blank out
// labels from a successful prior attempt.
export async function persistDiarizationLabels(
  supabase: ServiceClient,
  segments: SegmentForDiarization[],
  labelByDbId: Map<string, DiarizationSegmentLabel>,
): Promise<PersistDiarizationResult> {
  let labeled = 0;
  let unknown = 0;
  let lowPriority = 0;
  let missing = 0;

  for (const seg of segments) {
    const label = labelByDbId.get(seg.id);
    if (!label) {
      missing += 1;
      continue;
    }

    const speaker = label.speaker satisfies SpeakerLabel;
    if (speaker === "unknown") unknown += 1;
    if (label.lowPriority) lowPriority += 1;
    labeled += 1;

    const { error } = await supabase
      .from("transcript_segments")
      .update({
        speaker,
        speaker_confidence: label.confidence,
        speaker_notes: label.notes ?? null,
        speaker_low_priority: label.lowPriority,
      })
      .eq("id", seg.id);
    if (error) {
      throw new Error(
        `Could not update transcript_segments.${seg.id} with diarization label: ${error.message}`,
      );
    }
  }

  return {
    labeledCount: labeled,
    unknownCount: unknown,
    lowPriorityCount: lowPriority,
    missingCount: missing,
  };
}

async function extractingStep(ctx: StepContext): Promise<StepResult> {
  const { supabase, services, logger, job } = ctx;
  const segments = await loadSegmentsForExtraction(supabase, job.lesson_id);

  if (segments.length === 0) {
    logger.info("Extraction skipped — no transcript segments to extract from", {
      lessonId: job.lesson_id,
    });
    return {
      details: {
        provider: "noop",
        prompt_version: null,
        model: null,
        segment_count: 0,
        vocab_count: 0,
        new_vocab_count: 0,
        card_count: 0,
        grammar_count: 0,
        dialogue_count: 0,
        correction_count: 0,
      },
    };
  }

  const lesson = await loadLessonForExtraction(supabase, job.lesson_id);
  const promptSegments = buildExtractionPromptSegments(segments);
  const language = lesson.source_language ?? pickInputLanguage(segments);

  logger.info("Calling Anthropic extraction", {
    lessonId: job.lesson_id,
    segmentCount: promptSegments.length,
    language,
  });

  const { extraction, model, promptVersion } = await services.extract({
    sourceTranscriptId: job.lesson_id,
    language,
    segments: promptSegments,
  });

  const extractedAt = new Date().toISOString();
  const runVersion = await nextExtractionRunVersion(supabase, job.lesson_id);
  const writes = buildExtractionWrites({
    lesson,
    segments,
    extraction,
    model,
    promptVersion,
    extractedAt,
    runVersion,
  });

  // Reset the rows that aren't safe to rewrite in place (grammar + dialogue
  // have no per-user state hanging off them), mark all prior extraction_runs
  // for this lesson as superseded so the new version's rows are the only
  // "current" ones, then persist the new set. Teacher corrections are
  // upserted on a natural key so identical mistakes keep their existing
  // row id — and with it each user's correction_drills FSRS-like progress.
  await clearLessonOwnedExtractionRows(supabase, job.lesson_id);
  await markPriorExtractionRunsSuperseded(supabase, job.lesson_id, extractedAt);
  await persistLessonOwnedRows(supabase, writes);

  const resolvedVocab = await reconcileVocab(supabase, lesson.household_id, writes.vocab);
  const newVocabCount = resolvedVocab.filter((entry) => entry.isNew).length;

  const userIds = await loadHouseholdMemberIds(supabase, lesson.household_id);
  const knownPairs = await loadKnownWordPairs(
    supabase,
    userIds,
    resolvedVocab.map((entry) => entry.vocabItemId),
  );
  const cardRows = buildCardRows({
    lesson,
    resolvedVocab,
    userIds,
    knownPairs,
    model,
    promptVersion,
  });
  const cardCount = await persistCards(supabase, cardRows);

  logger.info("Persisted lesson extraction", {
    lessonId: job.lesson_id,
    runVersion,
    vocabCount: writes.vocab.length,
    newVocabCount,
    cardCount,
    grammarCount: writes.grammar.length,
    dialogueCount: writes.dialogue.length,
    correctionCount: writes.corrections.length,
    runCount: EXTRACTION_RUN_KINDS.length,
  });

  return {
    details: {
      provider: "anthropic-extraction",
      model,
      prompt_version: promptVersion,
      schema_version: extraction.schemaVersion,
      segment_count: segments.length,
      vocab_count: writes.vocab.length,
      new_vocab_count: newVocabCount,
      card_count: cardCount,
      grammar_count: writes.grammar.length,
      dialogue_count: writes.dialogue.length,
      correction_count: writes.corrections.length,
      run_version: runVersion,
    },
  };
}

async function generatingAudioStep(ctx: StepContext): Promise<StepResult> {
  const { supabase, source, services, logger, job } = ctx;
  // The `generating_audio` stage now has two concerns:
  // 1. VOL-126 — materialise dialogue clips extracted from the source recording.
  //    The extracting stage records clip storage paths; we cut the real audio
  //    objects here.
  // 2. VOL-118 — synthesise per-card Indonesian TTS for newly extracted vocab
  //    and cache it on the vocab_items rows.
  const clipResult = await materializeDialogueClips({
    supabase,
    lessonId: job.lesson_id,
    source,
    logger,
    mediaTools: services.mediaTools,
  });

  const lesson = await loadLessonForExtraction(supabase, job.lesson_id);
  const summary = await generateVocabAudioForLesson({
    supabase,
    synthesize: services.synthesize,
    logger,
    lessonId: lesson.id,
    householdId: lesson.household_id,
    voiceName: DEFAULT_INDONESIAN_VOICE,
    languageCode: INDONESIAN_LANGUAGE_CODE,
  });

  logger.info("Generated vocab TTS audio", {
    lessonId: lesson.id,
    candidates: summary.candidateCount,
    alreadyAttached: summary.alreadyAttachedCount,
    cacheHits: summary.cacheHitCount,
    synthesized: summary.synthesizedCount,
    failed: summary.failedCount,
  });

  return {
    details: {
      dialogue_clip_total: clipResult.totalCount,
      dialogue_clip_materialized: clipResult.materializedCount,
      dialogue_clip_skipped: clipResult.skippedCount,
      dialogue_clip_skips: clipResult.skipped,
      provider: GOOGLE_TTS_PROVIDER_ID,
      voice: DEFAULT_INDONESIAN_VOICE,
      language_code: INDONESIAN_LANGUAGE_CODE,
      candidate_count: summary.candidateCount,
      already_attached_count: summary.alreadyAttachedCount,
      cache_hit_count: summary.cacheHitCount,
      synthesized_count: summary.synthesizedCount,
      failed_count: summary.failedCount,
    },
  };
}

export type StepHandlerMap = Record<WorkerStage, StepHandler>;

export const STEPS: StepHandlerMap = {
  transcribing: transcribingStep,
  diarizing: diarizingStep,
  extracting: extractingStep,
  generating_audio: generatingAudioStep,
};

// Drives a single stage end-to-end. Skips when the stage is already marked
// complete in provider_metadata so retries pick up exactly where the previous
// attempt died. Accepts an explicit map so tests can inject step handlers
// without monkey-patching the module-level `STEPS` constant.
export async function runStage(
  ctx: StepContext,
  stage: WorkerStage,
  steps: StepHandlerMap = STEPS,
): Promise<JobRow> {
  if (isStageCompleted(ctx.job.provider_metadata, stage)) {
    ctx.logger.info(`Skipping ${stage} — already completed on a prior attempt`);
    return ctx.job;
  }
  const handler = steps[stage];
  const result = await handler(ctx);
  return markStageCompleted(ctx.supabase, ctx.job, stage, result.details);
}

export { WORKER_STAGES };
