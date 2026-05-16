import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Tables, TablesInsert } from "@reverb/db/types";
import {
  SCENARIO_KNOWN_VOCAB_LIMIT,
  SCENARIO_RECENT_CORRECTION_LIMIT,
  SCENARIO_RECENT_VOCAB_LIMIT,
  ScenarioIdSchema,
  type ScenarioConversationContext,
  type ScenarioCorrection,
  type ScenarioCorrectionHistoryItem,
  type ScenarioId,
  type ScenarioLevel,
  type ScenarioVocabContextItem,
} from "@reverb/domain";

export type ScenarioSession = Tables<"scenario_sessions">;
export type ScenarioMessage = Tables<"scenario_messages">;
export type ScenarioCorrectionRow = Tables<"scenario_corrections">;

// VOL-133: data access for scenario role-play sessions.
//
// Mirrors `lib/chat/sessions.ts` in shape (load/list/append messages with
// corrections joined in one round-trip) but stays in its own file because:
//   - the per-row XP + completion column lives on scenario_sessions only,
//   - the prompt context loader skips the rolling-summary field (scenes are
//     short enough that summarisation never kicks in),
//   - and a scenario session is keyed by a fixed `scenario_id` rather than
//     a single "active for this user" row, so the lookup shape differs.

export type ScenarioHistoryMessage = {
  id: string;
  role: ScenarioMessage["role"];
  content: string;
  language: string | null;
  createdAt: string;
  corrections: ScenarioCorrection[];
};

const HISTORY_WINDOW = 14;

export async function getScenarioSession(
  supabase: SupabaseClient<Database>,
  sessionId: string,
  userId: string,
): Promise<ScenarioSession | null> {
  const { data, error } = await supabase
    .from("scenario_sessions")
    .select("*")
    .eq("id", sessionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not load scenario session: ${error.message}`);
  }
  return data;
}

// Find an existing active scenario for (user, scenarioId), or create one.
// Re-using an active row lets a refresh, second tab, or mobile → laptop
// hand-off pick up the same in-progress scene rather than spawning a
// parallel one. Completed/abandoned scenes are intentionally not reused —
// the user explicitly chose to do that scenario again.
export async function getOrCreateActiveScenarioSession(
  supabase: SupabaseClient<Database>,
  userId: string,
  scenarioId: ScenarioId,
  level: ScenarioLevel,
): Promise<ScenarioSession> {
  // Validate the id at the boundary so a bad client request fails fast
  // instead of writing junk to the row.
  ScenarioIdSchema.parse(scenarioId);

  const { data: existing, error: existingError } = await supabase
    .from("scenario_sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("scenario_id", scenarioId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingError) {
    throw new Error(`Could not load scenario session: ${existingError.message}`);
  }
  if (existing) return existing;

  const insertRow: TablesInsert<"scenario_sessions"> = {
    user_id: userId,
    scenario_id: scenarioId,
    level,
  };
  const { data: inserted, error: insertError } = await supabase
    .from("scenario_sessions")
    .insert(insertRow)
    .select("*")
    .single();
  if (insertError || !inserted) {
    throw new Error(`Could not create scenario session: ${insertError?.message ?? "missing"}`);
  }
  return inserted;
}

// Loads the most recent N messages for a scenario session in chronological
// order (oldest → newest). Joins per-message corrections so the UI gets the
// full transcript shape in one round-trip.
export async function loadScenarioMessages(
  supabase: SupabaseClient<Database>,
  sessionId: string,
  userId: string,
  limit = HISTORY_WINDOW,
): Promise<ScenarioHistoryMessage[]> {
  const { data, error } = await supabase
    .from("scenario_messages")
    .select("id, role, content, language, created_at")
    .eq("session_id", sessionId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    throw new Error(`Could not load scenario messages: ${error.message}`);
  }
  const rows = (data ?? []).slice().reverse();
  if (rows.length === 0) return [];

  const messageIds = rows.map((r) => r.id);
  const { data: correctionRows, error: correctionError } = await supabase
    .from("scenario_corrections")
    .select("message_id, kind, source_text, corrected_text, explanation")
    .in("message_id", messageIds);
  if (correctionError) {
    throw new Error(`Could not load scenario corrections: ${correctionError.message}`);
  }
  const correctionsByMessage = new Map<string, ScenarioCorrection[]>();
  for (const row of correctionRows ?? []) {
    const list = correctionsByMessage.get(row.message_id) ?? [];
    list.push({
      kind: row.kind,
      sourceText: row.source_text,
      correctedText: row.corrected_text,
      explanation: row.explanation ?? undefined,
    });
    correctionsByMessage.set(row.message_id, list);
  }

  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    language: row.language,
    createdAt: row.created_at,
    corrections: correctionsByMessage.get(row.id) ?? [],
  }));
}

export function toScenarioTurns(
  messages: ScenarioHistoryMessage[],
): { role: "user" | "assistant"; content: string }[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

// Build the conversation context the AI adapter consumes. Pulls the same
// vocab + correction sources as the chat partner so the role-play stays
// anchored on the user's actual deck.
export type BuildScenarioContextOptions = {
  knownVocabLimit?: number;
  recentVocabLimit?: number;
  recentCorrectionLimit?: number;
};

export async function buildScenarioConversationContext(
  supabase: SupabaseClient<Database>,
  userId: string,
  session: Pick<ScenarioSession, "scenario_id" | "level" | "total_user_messages">,
  options: BuildScenarioContextOptions = {},
): Promise<ScenarioConversationContext> {
  const knownLimit = options.knownVocabLimit ?? SCENARIO_KNOWN_VOCAB_LIMIT;
  const recentLimit = options.recentVocabLimit ?? SCENARIO_RECENT_VOCAB_LIMIT;
  const correctionLimit = options.recentCorrectionLimit ?? SCENARIO_RECENT_CORRECTION_LIMIT;

  // Known vocab: user_known_words first, then stable cards. Same ranking as
  // the chat builder.
  const known: ScenarioVocabContextItem[] = [];
  const seenLemmas = new Set<string>();

  const { data: knownRows, error: knownError } = await supabase
    .from("user_known_words")
    .select("vocab_item_id, vocab_item:vocab_items!inner(lemma, translation)")
    .eq("user_id", userId)
    .order("marked_at", { ascending: false })
    .limit(knownLimit);
  if (knownError) {
    throw new Error(`Could not load user_known_words: ${knownError.message}`);
  }
  for (const row of knownRows ?? []) {
    const vocab = Array.isArray(row.vocab_item) ? row.vocab_item[0] : row.vocab_item;
    if (!vocab) continue;
    if (seenLemmas.has(vocab.lemma)) continue;
    known.push({ lemma: vocab.lemma, translation: vocab.translation });
    seenLemmas.add(vocab.lemma);
  }

  if (known.length < knownLimit) {
    const { data: stableCards, error: cardsError } = await supabase
      .from("cards")
      .select("stability, vocab_item:vocab_items!inner(lemma, translation)")
      .eq("user_id", userId)
      .gt("stability", 5)
      .order("stability", { ascending: false })
      .limit(knownLimit - known.length);
    if (cardsError) {
      throw new Error(`Could not load cards: ${cardsError.message}`);
    }
    for (const row of stableCards ?? []) {
      const vocab = Array.isArray(row.vocab_item) ? row.vocab_item[0] : row.vocab_item;
      if (!vocab) continue;
      if (seenLemmas.has(vocab.lemma)) continue;
      known.push({ lemma: vocab.lemma, translation: vocab.translation });
      seenLemmas.add(vocab.lemma);
    }
  }

  // Recent lesson vocab.
  const recent: ScenarioVocabContextItem[] = [];
  const { data: recentVocab, error: recentVocabError } = await supabase
    .from("vocab_items")
    .select("lemma, translation, created_at")
    .order("created_at", { ascending: false })
    .limit(recentLimit * 2);
  if (recentVocabError) {
    throw new Error(`Could not load recent vocab: ${recentVocabError.message}`);
  }
  for (const row of recentVocab ?? []) {
    if (seenLemmas.has(row.lemma)) continue;
    recent.push({ lemma: row.lemma, translation: row.translation });
    seenLemmas.add(row.lemma);
    if (recent.length >= recentLimit) break;
  }

  // Recent corrections — scenario_corrections first, then chat_corrections,
  // then teacher_corrections. Capped at correctionLimit. Three sources so a
  // brand-new scenario user still has lesson-derived feedback in scope.
  const corrections: ScenarioCorrectionHistoryItem[] = [];
  const { data: scenarioCorrections, error: scenarioCorrectionError } = await supabase
    .from("scenario_corrections")
    .select("source_text, corrected_text, kind, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(correctionLimit);
  if (scenarioCorrectionError) {
    throw new Error(`Could not load scenario corrections: ${scenarioCorrectionError.message}`);
  }
  for (const row of scenarioCorrections ?? []) {
    corrections.push({
      sourceText: row.source_text,
      correctedText: row.corrected_text,
      kind: row.kind,
    });
  }
  if (corrections.length < correctionLimit) {
    const { data: chatCorrections, error: chatCorrectionError } = await supabase
      .from("chat_corrections")
      .select("source_text, corrected_text, kind, created_at")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(correctionLimit - corrections.length);
    if (chatCorrectionError) {
      throw new Error(`Could not load chat corrections: ${chatCorrectionError.message}`);
    }
    for (const row of chatCorrections ?? []) {
      corrections.push({
        sourceText: row.source_text,
        correctedText: row.corrected_text,
        kind: row.kind,
      });
    }
  }
  if (corrections.length < correctionLimit) {
    const { data: teacherCorrections, error: teacherCorrectionError } = await supabase
      .from("teacher_corrections")
      .select("source_text, corrected_text, kind, created_at")
      .order("created_at", { ascending: false })
      .limit(correctionLimit - corrections.length);
    if (teacherCorrectionError) {
      throw new Error(`Could not load teacher corrections: ${teacherCorrectionError.message}`);
    }
    for (const row of teacherCorrections ?? []) {
      corrections.push({
        sourceText: row.source_text,
        correctedText: row.corrected_text,
        kind: row.kind,
      });
    }
  }

  const parsedScenarioId = ScenarioIdSchema.parse(session.scenario_id);
  const level = normaliseLevel(session.level);

  return {
    scenarioId: parsedScenarioId,
    level,
    knownVocab: known,
    recentLessonVocab: recent,
    recentCorrections: corrections,
    userTurnCount: session.total_user_messages,
  };
}

function normaliseLevel(value: string): ScenarioLevel {
  if (value === "intermediate" || value === "advanced") return value;
  return "beginner";
}
