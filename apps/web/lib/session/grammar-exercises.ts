import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@reverb/db/types";
import { GRAMMAR_EXERCISE_KINDS, type GrammarExerciseKind } from "@reverb/domain";

// VOL-129: Per-user view onto a generated grammar exercise.
//
// The DB stores exercises household-shared (one row per detected pattern's
// generated set). The per-user "have I seen this yet" state lives on
// `practice_session_items` — when the orchestrator slots an exercise into
// a session it inserts a row pointing at the exercise id. So a user never
// sees the same exercise twice unless we explicitly choose to re-surface
// it (the mastery dashboard will surface "weak patterns" later via this
// same data).
//
// The view shape mirrors the DB columns but with `accepted_answers` and
// `choices` parsed into plain string arrays for the runner to grade
// against directly — the jsonb columns are typed as `Json` so the parsing
// also acts as a contract check between the generator and the UI.

export type SessionGrammarExercise = {
  exerciseId: string;
  kind: GrammarExerciseKind;
  prompt: string;
  answer: string;
  // For `multiple_choice`: the choice texts in the order the model emitted
  // them. Empty array for the other kinds.
  choices: string[];
  // For `fill_blank` and `transform`: additional accepted spellings /
  // rephrasings. Empty array for `multiple_choice` (it has `choices`
  // instead).
  acceptedAnswers: string[];
  explanation: string | null;
  pattern: string | null;
  patternId: string | null;
  lessonId: string | null;
  lessonTitle: string | null;
  promptVersion: string | null;
};

// Loads up to N grammar exercises the user hasn't yet attempted, ordered by
// most-recent-lesson-first. Returns null when there's nothing eligible —
// the orchestrator treats that as "skip the grammar slot for today" and
// falls back to vocab + mistake drills.
export async function loadNextGrammarExercise(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<SessionGrammarExercise | null> {
  // 1. Pull the set of exercises the user has already seen (any session,
  //    any day). This is bounded by the user's lifetime activity; for the
  //    MVP household (one user, dozens of lessons) the row count stays
  //    tiny. When the cohort scales we can replace this with a SQL
  //    not-exists / left-anti join.
  const { data: seenRows, error: seenError } = await supabase
    .from("practice_session_items")
    .select("grammar_exercise_id")
    .eq("user_id", userId)
    .eq("kind", "grammar_exercise");
  if (seenError) {
    throw new Error(`Could not load seen grammar exercises: ${seenError.message}`);
  }
  const seenIds = new Set<string>();
  for (const row of seenRows ?? []) {
    if (row.grammar_exercise_id) seenIds.add(row.grammar_exercise_id);
  }

  // 2. Load a candidate window. We cap the read so a household with
  //    thousands of generated exercises doesn't pull the whole table. New
  //    lessons land at the top via `created_at desc`.
  const { data: rows, error } = await supabase
    .from("grammar_exercises")
    .select(
      "id, kind, prompt, answer, choices, accepted_answers, explanation, prompt_version, lesson_id, grammar_pattern_id, grammar_pattern:grammar_patterns!grammar_exercises_grammar_pattern_id_fkey(pattern)",
    )
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    throw new Error(`Could not load grammar exercises: ${error.message}`);
  }
  if (!rows || rows.length === 0) return null;

  const candidate = rows.find((row) => !seenIds.has(row.id)) ?? null;
  if (!candidate) return null;

  // 3. Validate the kind belongs to the supported set. Schema drift (the
  //    DB enum still has legacy `translate` / `reorder` values) means we
  //    can't blindly trust the stored row — drop it from selection so the
  //    runner never receives a kind it doesn't know how to render.
  if (!isSupportedKind(candidate.kind)) return null;

  const choices = parseStringArray(candidate.choices);
  const acceptedAnswers = parseStringArray(candidate.accepted_answers);

  // 4. Resolve the lesson title and pattern label for the runner's
  //    breadcrumbs. Failures here are non-fatal — the exercise still
  //    renders with the prompt/answer/explanation.
  let lessonTitle: string | null = null;
  if (candidate.lesson_id) {
    const { data: lesson } = await supabase
      .from("lessons")
      .select("title")
      .eq("id", candidate.lesson_id)
      .maybeSingle();
    lessonTitle = lesson?.title ?? null;
  }
  const patternRaw = Array.isArray(candidate.grammar_pattern)
    ? candidate.grammar_pattern[0]
    : candidate.grammar_pattern;
  const pattern = patternRaw?.pattern ?? null;

  return {
    exerciseId: candidate.id,
    kind: candidate.kind,
    prompt: candidate.prompt,
    answer: candidate.answer,
    choices,
    acceptedAnswers,
    explanation: candidate.explanation,
    pattern,
    patternId: candidate.grammar_pattern_id,
    lessonId: candidate.lesson_id,
    lessonTitle,
    promptVersion: candidate.prompt_version,
  };
}

// Hydrate a set of grammar_exercises rows by id. Used by the orchestrator's
// session hydration step (the queue is materialised at session-start time,
// so on resume we re-fetch by the ids stored in `practice_session_items`).
export async function loadGrammarExercisesByIds(
  supabase: SupabaseClient<Database>,
  ids: string[],
): Promise<Map<string, SessionGrammarExercise>> {
  const out = new Map<string, SessionGrammarExercise>();
  if (ids.length === 0) return out;
  const { data: rows, error } = await supabase
    .from("grammar_exercises")
    .select(
      "id, kind, prompt, answer, choices, accepted_answers, explanation, prompt_version, lesson_id, grammar_pattern_id, grammar_pattern:grammar_patterns!grammar_exercises_grammar_pattern_id_fkey(pattern)",
    )
    .in("id", ids);
  if (error) {
    throw new Error(`Could not load grammar exercises by id: ${error.message}`);
  }
  const lessonIds = new Set<string>();
  for (const row of rows ?? []) {
    if (row.lesson_id) lessonIds.add(row.lesson_id);
  }
  let lessonTitles = new Map<string, string>();
  if (lessonIds.size > 0) {
    const { data: lessons } = await supabase
      .from("lessons")
      .select("id, title")
      .in("id", Array.from(lessonIds));
    if (lessons) lessonTitles = new Map(lessons.map((l) => [l.id, l.title] as const));
  }
  for (const row of rows ?? []) {
    if (!isSupportedKind(row.kind)) continue;
    const patternRaw = Array.isArray(row.grammar_pattern)
      ? row.grammar_pattern[0]
      : row.grammar_pattern;
    out.set(row.id, {
      exerciseId: row.id,
      kind: row.kind,
      prompt: row.prompt,
      answer: row.answer,
      choices: parseStringArray(row.choices),
      acceptedAnswers: parseStringArray(row.accepted_answers),
      explanation: row.explanation,
      pattern: patternRaw?.pattern ?? null,
      patternId: row.grammar_pattern_id,
      lessonId: row.lesson_id,
      lessonTitle: row.lesson_id ? (lessonTitles.get(row.lesson_id) ?? null) : null,
      promptVersion: row.prompt_version,
    });
  }
  return out;
}

function isSupportedKind(value: unknown): value is GrammarExerciseKind {
  return (
    typeof value === "string" &&
    (GRAMMAR_EXERCISE_KINDS as ReadonlyArray<string>).includes(value)
  );
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim().length > 0) out.push(entry);
  }
  return out;
}
