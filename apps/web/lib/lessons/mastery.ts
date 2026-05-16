import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@reverb/db/types";
import { createServerSupabaseClient } from "@/lib/supabase/server";

// VOL-134: Per-lesson mastery dashboard.
//
// "Mastery" is calculated from the existing per-user practice state — we
// never expose a manual toggle. The three buckets line up with what gets
// extracted from a lesson:
//
//   * Vocab    — `vocab_items` produce `cards` once the user starts
//                reviewing them. A card is "mastered" when its FSRS
//                scheduled_days (the interval to the next review) is at
//                least 21 days, the heuristic shared with the rest of the
//                product for "this has graduated from short-term review".
//   * Grammar  — `grammar_exercises` are seen at most once by default
//                (orchestrator suppresses re-shows), so the row inserted
//                into `practice_session_items` carries the first-try
//                outcome on its `correct` column.
//   * Mistakes — `teacher_corrections` get a per-user `correction_drills`
//                row. A drill in state='retired' is one the user passed
//                often enough that we stopped scheduling it.
//
// A lesson that wasn't extracted for a given content type (no vocab, no
// grammar exercises, or no corrections) reports `percent: null` for that
// bucket so the dashboard can render "—" rather than a misleading 0% or
// 100%.

export const FSRS_MASTERY_INTERVAL_DAYS = 21;

export type MasteryStat = {
  total: number;
  mastered: number;
  percent: number | null;
};

export type LessonMastery = {
  vocab: MasteryStat;
  grammar: MasteryStat;
  corrections: MasteryStat;
};

export type LessonMasteryInput = {
  vocab: { itemId: string; scheduledDays: number | null }[];
  grammar: { exerciseId: string; firstTryCorrect: boolean | null }[];
  corrections: { correctionId: string; state: "new" | "learning" | "retired" | null }[];
};

// Pure, fixture-friendly. Each list is the lesson's complete set of
// extracted content for that bucket, joined to the user's progress (or
// null when the user hasn't started practising that item yet).
export function calculateLessonMastery(input: LessonMasteryInput): LessonMastery {
  return {
    vocab: makeStat(
      input.vocab.length,
      input.vocab.filter((item) => (item.scheduledDays ?? 0) >= FSRS_MASTERY_INTERVAL_DAYS).length,
    ),
    grammar: makeStat(
      input.grammar.length,
      input.grammar.filter((item) => item.firstTryCorrect === true).length,
    ),
    corrections: makeStat(
      input.corrections.length,
      input.corrections.filter((item) => item.state === "retired").length,
    ),
  };
}

function makeStat(total: number, mastered: number): MasteryStat {
  if (total === 0) return { total: 0, mastered: 0, percent: null };
  return { total, mastered, percent: Math.round((mastered / total) * 100) };
}

export function isMasteryEmpty(mastery: LessonMastery): boolean {
  return (
    mastery.vocab.total === 0 && mastery.grammar.total === 0 && mastery.corrections.total === 0
  );
}

// Loader: pull the inputs for a single lesson from Supabase. RLS keeps the
// household-shared reads scoped to the user's household; the per-user
// tables (cards, practice_session_items, correction_drills) only return
// rows for the caller.
export async function loadLessonMastery(
  lessonId: string,
  userId: string,
): Promise<LessonMastery | null> {
  const supabase = await createServerSupabaseClient();
  if (!supabase) return null;
  const map = await loadLessonMasteryBatchWith(supabase, [lessonId], userId);
  return map.get(lessonId) ?? calculateLessonMastery({ vocab: [], grammar: [], corrections: [] });
}

// Batch loader: returns a per-lesson mastery map. Used by the archive
// view so we make one round-trip per content type instead of N. Lessons
// with no extracted content of any type still get an all-empty record so
// callers can render "—" without a fallback path.
export async function loadLessonMasteryBatch(
  lessonIds: string[],
  userId: string,
): Promise<Map<string, LessonMastery>> {
  if (lessonIds.length === 0) return new Map();
  const supabase = await createServerSupabaseClient();
  if (!supabase) return new Map();
  return loadLessonMasteryBatchWith(supabase, lessonIds, userId);
}

async function loadLessonMasteryBatchWith(
  supabase: SupabaseClient<Database>,
  lessonIds: string[],
  userId: string,
): Promise<Map<string, LessonMastery>> {
  const [vocabRows, grammarRows, correctionRows] = await Promise.all([
    loadVocabRowsForLessons(supabase, lessonIds, userId),
    loadGrammarRowsForLessons(supabase, lessonIds, userId),
    loadCorrectionRowsForLessons(supabase, lessonIds, userId),
  ]);

  const byLesson = new Map<string, LessonMasteryInput>();
  function bucket(lessonId: string): LessonMasteryInput {
    let entry = byLesson.get(lessonId);
    if (!entry) {
      entry = { vocab: [], grammar: [], corrections: [] };
      byLesson.set(lessonId, entry);
    }
    return entry;
  }

  for (const row of vocabRows) bucket(row.lessonId).vocab.push(row);
  for (const row of grammarRows) bucket(row.lessonId).grammar.push(row);
  for (const row of correctionRows) bucket(row.lessonId).corrections.push(row);

  const out = new Map<string, LessonMastery>();
  for (const id of lessonIds) {
    const input = byLesson.get(id) ?? { vocab: [], grammar: [], corrections: [] };
    out.set(id, calculateLessonMastery(input));
  }
  return out;
}

type VocabRow = {
  lessonId: string;
  itemId: string;
  scheduledDays: number | null;
};

async function loadVocabRowsForLessons(
  supabase: SupabaseClient<Database>,
  lessonIds: string[],
  userId: string,
): Promise<VocabRow[]> {
  const { data: items, error } = await supabase
    .from("vocab_items")
    .select("id, lesson_id")
    .in("lesson_id", lessonIds);
  if (error || !items || items.length === 0) return [];

  const itemIds = items.map((row) => row.id);
  const { data: cardRows } = await supabase
    .from("cards")
    .select("vocab_item_id, scheduled_days")
    .eq("user_id", userId)
    .in("vocab_item_id", itemIds);

  const scheduledByItem = new Map<string, number>();
  for (const row of cardRows ?? []) {
    scheduledByItem.set(row.vocab_item_id, row.scheduled_days);
  }

  const out: VocabRow[] = [];
  for (const item of items) {
    if (!item.lesson_id) continue;
    const scheduledDays = scheduledByItem.has(item.id) ? (scheduledByItem.get(item.id) ?? 0) : null;
    out.push({ lessonId: item.lesson_id, itemId: item.id, scheduledDays });
  }
  return out;
}

type GrammarRow = {
  lessonId: string;
  exerciseId: string;
  // null when the user hasn't answered any session item for this exercise.
  // The user can re-encounter an exercise across sessions, so we collapse
  // every matching row down to the chronologically earliest answered one.
  firstTryCorrect: boolean | null;
};

async function loadGrammarRowsForLessons(
  supabase: SupabaseClient<Database>,
  lessonIds: string[],
  userId: string,
): Promise<GrammarRow[]> {
  const { data: exerciseRows, error: exerciseError } = await supabase
    .from("grammar_exercises")
    .select("id, lesson_id")
    .in("lesson_id", lessonIds);
  if (exerciseError || !exerciseRows || exerciseRows.length === 0) return [];

  const exerciseIds = exerciseRows.map((r) => r.id);
  const { data: itemRows } = await supabase
    .from("practice_session_items")
    .select("grammar_exercise_id, correct, answered_at")
    .eq("user_id", userId)
    .eq("kind", "grammar_exercise")
    .in("grammar_exercise_id", exerciseIds);

  const firstByExercise = collapseFirstAttempts(itemRows ?? []);

  const out: GrammarRow[] = [];
  for (const row of exerciseRows) {
    if (!row.lesson_id) continue;
    const attempt = firstByExercise.get(row.id);
    out.push({
      lessonId: row.lesson_id,
      exerciseId: row.id,
      // An inserted-but-unanswered session item (orchestrator queued the
      // exercise but the user navigated away) is treated as no attempt.
      firstTryCorrect: attempt && attempt.answeredAt ? attempt.correct : null,
    });
  }
  return out;
}

function collapseFirstAttempts(
  rows: {
    grammar_exercise_id: string | null;
    correct: boolean | null;
    answered_at: string | null;
  }[],
): Map<string, { correct: boolean | null; answeredAt: string | null }> {
  const out = new Map<string, { correct: boolean | null; answeredAt: string | null }>();
  for (const row of rows) {
    if (!row.grammar_exercise_id) continue;
    const existing = out.get(row.grammar_exercise_id);
    if (!existing) {
      out.set(row.grammar_exercise_id, { correct: row.correct, answeredAt: row.answered_at });
      continue;
    }
    if (!existing.answeredAt && row.answered_at) {
      out.set(row.grammar_exercise_id, { correct: row.correct, answeredAt: row.answered_at });
      continue;
    }
    if (existing.answeredAt && row.answered_at && row.answered_at < existing.answeredAt) {
      out.set(row.grammar_exercise_id, { correct: row.correct, answeredAt: row.answered_at });
    }
  }
  return out;
}

type CorrectionRow = {
  lessonId: string;
  correctionId: string;
  state: "new" | "learning" | "retired" | null;
};

async function loadCorrectionRowsForLessons(
  supabase: SupabaseClient<Database>,
  lessonIds: string[],
  userId: string,
): Promise<CorrectionRow[]> {
  const { data: corrections, error } = await supabase
    .from("teacher_corrections")
    .select("id, lesson_id")
    .in("lesson_id", lessonIds);
  if (error || !corrections || corrections.length === 0) return [];

  const correctionIds = corrections.map((row) => row.id);
  const { data: drillRows } = await supabase
    .from("correction_drills")
    .select("teacher_correction_id, state")
    .eq("user_id", userId)
    .in("teacher_correction_id", correctionIds);

  const stateByCorrection = new Map<string, "new" | "learning" | "retired">();
  for (const row of drillRows ?? []) {
    stateByCorrection.set(row.teacher_correction_id, row.state);
  }

  const out: CorrectionRow[] = [];
  for (const row of corrections) {
    if (!row.lesson_id) continue;
    out.push({
      lessonId: row.lesson_id,
      correctionId: row.id,
      state: stateByCorrection.get(row.id) ?? null,
    });
  }
  return out;
}
