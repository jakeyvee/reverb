import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Tables } from "@reverb/db/types";
import {
  CORRECTION_DRILL_MIN_CONFIDENCE,
  classifyCorrectionConfidence,
  type CorrectionConfidenceTier,
} from "@reverb/domain/schemas/correction-drill";

export type CorrectionDrillView = {
  drillId: string;
  state: "new" | "learning";
  dueAt: string;
  attempts: number;
  passes: number;
  fails: number;
  consecutivePasses: number;
  xpEarned: number;
  correction: {
    id: string;
    kind: Tables<"teacher_corrections">["kind"];
    sourceText: string;
    correctedText: string;
    explanation: string | null;
    confidence: number | null;
    lessonId: string;
  };
  confidenceTier: CorrectionConfidenceTier;
};

export type DailySessionView = {
  corrections: CorrectionDrillView[];
  freshVocab: VocabPreview[];
  // Counts of corrections that exist for the household but are filtered out
  // by the session loader (retired or below the min-confidence threshold).
  filtered: {
    retired: number;
    lowConfidence: number;
  };
};

export type VocabPreview = {
  vocabItemId: string;
  cardId: string | null;
  lemma: string;
  translation: string | null;
  dueAt: string | null;
};

const DEFAULT_CORRECTION_LIMIT = 12;
const DEFAULT_FRESH_VOCAB_LIMIT = 8;

// Materializes a `correction_drills` row for every household correction the
// caller doesn't already have one for. Inserts respect RLS (the policy
// requires the teacher_correction to belong to current_household_id()), so a
// client cannot spawn drills for another household.
//
// This is "lazy projection" — drills don't exist until the user opens their
// session for the first time. That keeps the extracting step itself
// household-scoped without needing it to know who the household members are.
export async function ensureCorrectionDrillsForUser(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<{ created: number }> {
  const { data: corrections, error: correctionsError } = await supabase
    .from("teacher_corrections")
    .select("id");
  if (correctionsError) {
    throw new Error(`Could not list teacher_corrections: ${correctionsError.message}`);
  }
  if (!corrections || corrections.length === 0) return { created: 0 };

  const { data: existing, error: existingError } = await supabase
    .from("correction_drills")
    .select("teacher_correction_id")
    .eq("user_id", userId)
    .in(
      "teacher_correction_id",
      corrections.map((row) => row.id),
    );
  if (existingError) {
    throw new Error(`Could not list correction_drills: ${existingError.message}`);
  }

  const have = new Set((existing ?? []).map((row) => row.teacher_correction_id));
  const missing = corrections.filter((row) => !have.has(row.id));
  if (missing.length === 0) return { created: 0 };

  const rows = missing.map((row) => ({
    user_id: userId,
    teacher_correction_id: row.id,
  }));
  const { error: insertError } = await supabase.from("correction_drills").insert(rows);
  if (insertError) {
    throw new Error(`Could not insert correction_drills: ${insertError.message}`);
  }
  return { created: rows.length };
}

export type LoadDailySessionOptions = {
  now?: Date;
  correctionLimit?: number;
  freshVocabLimit?: number;
};

// Builds the prioritized daily session list. Returns correction drills that
// are due now first, then fresh vocab cards as filler. Correction drills sit
// ahead of vocab in the session UI even when both are due simultaneously —
// that's the whole point of this issue.
export async function loadDailySession(
  supabase: SupabaseClient<Database>,
  userId: string,
  options: LoadDailySessionOptions = {},
): Promise<DailySessionView> {
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const correctionLimit = options.correctionLimit ?? DEFAULT_CORRECTION_LIMIT;
  const freshVocabLimit = options.freshVocabLimit ?? DEFAULT_FRESH_VOCAB_LIMIT;

  // The PostgREST `not.eq.retired` filter does the heavy lifting for the
  // state column. We still apply the due_at check + min-confidence filter
  // here so a future "snooze" toggle plugs in without a fresh round-trip.
  const { data: drillRows, error: drillError } = await supabase
    .from("correction_drills")
    .select(
      "id, state, due_at, attempts, passes, fails, consecutive_passes, xp_earned, teacher_correction:teacher_corrections!inner(id, kind, source_text, corrected_text, explanation, confidence, lesson_id)",
    )
    .eq("user_id", userId)
    .neq("state", "retired")
    .lte("due_at", nowIso)
    .order("due_at", { ascending: true })
    // We fetch +1 so we can report when a drill was hidden by the
    // confidence filter without a second query.
    .limit(correctionLimit * 2);
  if (drillError) {
    throw new Error(`Could not load correction drills: ${drillError.message}`);
  }

  let lowConfidenceFiltered = 0;
  const corrections: CorrectionDrillView[] = [];
  for (const row of drillRows ?? []) {
    const correction = Array.isArray(row.teacher_correction)
      ? row.teacher_correction[0]
      : row.teacher_correction;
    if (!correction) continue;
    const tier = classifyCorrectionConfidence(correction.confidence);
    if (tier === "ineligible") {
      lowConfidenceFiltered += 1;
      continue;
    }
    if (corrections.length >= correctionLimit) continue;
    corrections.push({
      drillId: row.id,
      state: row.state === "new" ? "new" : "learning",
      dueAt: row.due_at,
      attempts: row.attempts,
      passes: row.passes,
      fails: row.fails,
      consecutivePasses: row.consecutive_passes,
      xpEarned: row.xp_earned,
      correction: {
        id: correction.id,
        kind: correction.kind,
        sourceText: correction.source_text,
        correctedText: correction.corrected_text,
        explanation: correction.explanation,
        confidence: correction.confidence,
        lessonId: correction.lesson_id,
      },
      confidenceTier: tier,
    });
  }

  const { count: retiredCount } = await supabase
    .from("correction_drills")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("state", "retired");

  const freshVocab = await loadFreshVocabPreview(supabase, userId, freshVocabLimit);

  return {
    corrections,
    freshVocab,
    filtered: {
      retired: retiredCount ?? 0,
      lowConfidence: lowConfidenceFiltered,
    },
  };
}

// Lightweight vocab preview that lives alongside correction drills in the
// session UI. We surface vocab items the user doesn't have a `cards` row for
// yet (truly "fresh") so the daily-session counters can show what's queued
// behind the higher-priority corrections.
async function loadFreshVocabPreview(
  supabase: SupabaseClient<Database>,
  userId: string,
  limit: number,
): Promise<VocabPreview[]> {
  // Pull all vocab items in the household. RLS scopes this by current
  // household automatically.
  const { data: vocabRows, error: vocabError } = await supabase
    .from("vocab_items")
    .select("id, lemma, translation, lesson_id, created_at")
    .order("created_at", { ascending: false })
    .limit(limit * 4);
  if (vocabError) {
    throw new Error(`Could not load vocab_items: ${vocabError.message}`);
  }
  if (!vocabRows || vocabRows.length === 0) return [];

  const { data: cards, error: cardsError } = await supabase
    .from("cards")
    .select("id, vocab_item_id, due_at")
    .eq("user_id", userId)
    .in(
      "vocab_item_id",
      vocabRows.map((row) => row.id),
    );
  if (cardsError) {
    throw new Error(`Could not load cards: ${cardsError.message}`);
  }

  const cardByVocab = new Map(
    (cards ?? []).map((card) => [card.vocab_item_id, card] as const),
  );

  const out: VocabPreview[] = [];
  for (const vocab of vocabRows) {
    const card = cardByVocab.get(vocab.id);
    out.push({
      vocabItemId: vocab.id,
      cardId: card?.id ?? null,
      lemma: vocab.lemma,
      translation: vocab.translation,
      dueAt: card?.due_at ?? null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export { CORRECTION_DRILL_MIN_CONFIDENCE };
