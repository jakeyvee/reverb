import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Tables, TablesInsert } from "@reverb/db/types";
import {
  CHAT_HISTORY_WINDOW,
  CHAT_KNOWN_VOCAB_LIMIT,
  CHAT_RECENT_CORRECTION_LIMIT,
  CHAT_RECENT_VOCAB_LIMIT,
  ChatLevelSchema,
  type ChatConversationContext,
  type ChatCorrection,
  type ChatCorrectionHistoryItem,
  type ChatLevel,
  type ChatTurn,
  type ChatVocabContextItem,
} from "@reverb/domain";

export type ChatSession = Tables<"chat_sessions">;
export type ChatMessage = Tables<"chat_messages">;
export type ChatCorrectionRow = Tables<"chat_corrections">;

export type ChatHistoryMessage = {
  id: string;
  role: ChatTurn["role"];
  content: string;
  language: string | null;
  createdAt: string;
  corrections: ChatCorrection[];
};

// Returns the user's currently active chat session, materialising one if
// none exists. RLS scopes both the select and the insert to the caller, so
// a second user cannot claim or read this row. Idempotent: concurrent calls
// from a page load + first message both land on the same active row because
// we resolve "active" by ORDER BY last_message_at DESC, falling back to the
// most recently created row.
export async function getOrCreateActiveSession(
  supabase: SupabaseClient<Database>,
  userId: string,
  level: ChatLevel = "beginner",
): Promise<ChatSession> {
  const { data: existing, error: existingError } = await supabase
    .from("chat_sessions")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingError) {
    throw new Error(`Could not load chat session: ${existingError.message}`);
  }
  if (existing) return existing;

  const insertRow: TablesInsert<"chat_sessions"> = {
    user_id: userId,
    level,
  };
  const { data: inserted, error: insertError } = await supabase
    .from("chat_sessions")
    .insert(insertRow)
    .select("*")
    .single();
  if (insertError || !inserted) {
    throw new Error(`Could not create chat session: ${insertError?.message ?? "missing"}`);
  }
  return inserted;
}

// Ends the user's currently active session and starts a fresh one. Used by
// the "Start over" button in the chat UI. We mark the old row's ended_at
// + status='ended' so the rolling history doesn't bleed into the new
// session's prompt context.
export async function startNewSession(
  supabase: SupabaseClient<Database>,
  userId: string,
  level: ChatLevel = "beginner",
): Promise<ChatSession> {
  const now = new Date().toISOString();
  const { error: updateError } = await supabase
    .from("chat_sessions")
    .update({ status: "ended", ended_at: now })
    .eq("user_id", userId)
    .eq("status", "active");
  if (updateError) {
    throw new Error(`Could not end current chat session: ${updateError.message}`);
  }

  const insertRow: TablesInsert<"chat_sessions"> = {
    user_id: userId,
    level,
  };
  const { data: inserted, error: insertError } = await supabase
    .from("chat_sessions")
    .insert(insertRow)
    .select("*")
    .single();
  if (insertError || !inserted) {
    throw new Error(`Could not start new chat session: ${insertError?.message ?? "missing"}`);
  }
  return inserted;
}

// Loads the most recent N messages for a session in chronological order
// (oldest → newest) so the UI can render them top-to-bottom. Joins in the
// per-message corrections so the assistant turn ahead of each user message
// gets its corrections nested without a separate round-trip.
export async function loadSessionMessages(
  supabase: SupabaseClient<Database>,
  sessionId: string,
  userId: string,
  limit = CHAT_HISTORY_WINDOW,
): Promise<ChatHistoryMessage[]> {
  const { data, error } = await supabase
    .from("chat_messages")
    .select("id, role, content, language, created_at")
    .eq("session_id", sessionId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    throw new Error(`Could not load chat messages: ${error.message}`);
  }
  const rows = (data ?? []).slice().reverse();
  if (rows.length === 0) return [];

  const messageIds = rows.map((r) => r.id);
  const { data: correctionRows, error: correctionError } = await supabase
    .from("chat_corrections")
    .select("message_id, kind, source_text, corrected_text, explanation")
    .in("message_id", messageIds);
  if (correctionError) {
    throw new Error(`Could not load chat corrections: ${correctionError.message}`);
  }
  const correctionsByMessage = new Map<string, ChatCorrection[]>();
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

// Maps the bounded session tail to the AI adapter's ChatTurn shape. The
// adapter prepends the new user message itself, so we don't include it.
export function toChatTurns(messages: ChatHistoryMessage[]): ChatTurn[] {
  return messages.map((m) => ({ role: m.role, content: m.content }));
}

// Builds the structured context payload the AI adapter consumes. Reads:
//   - vocab_items + cards: ranks known/fresh vocab for the user.
//   - teacher_corrections (household): the user's mistake history from
//     lessons. We pull recent corrections regardless of drill state so the
//     model can still re-test something the user has been corrected on
//     even if the drill row is retired.
//   - chat_corrections (per-user): the user's recent chat mistake history.
//     Merged with teacher corrections, capped at CHAT_RECENT_CORRECTION_LIMIT.
//   - chat_sessions.summary: the rolling summary, if any.
//
// All reads are RLS-scoped — vocab via household, the rest via auth.uid().
export type BuildContextOptions = {
  knownVocabLimit?: number;
  recentVocabLimit?: number;
  recentCorrectionLimit?: number;
};

export async function buildConversationContext(
  supabase: SupabaseClient<Database>,
  userId: string,
  session: Pick<ChatSession, "id" | "level" | "summary">,
  options: BuildContextOptions = {},
): Promise<ChatConversationContext> {
  const knownLimit = options.knownVocabLimit ?? CHAT_KNOWN_VOCAB_LIMIT;
  const recentLimit = options.recentVocabLimit ?? CHAT_RECENT_VOCAB_LIMIT;
  const correctionLimit = options.recentCorrectionLimit ?? CHAT_RECENT_CORRECTION_LIMIT;

  // Known vocab — either user_known_words ("I already know this") or cards
  // the user has graded confidently. We grab user_known_words first; if
  // there is room left, we fill from `cards` ordered by stability desc.
  const known: ChatVocabContextItem[] = [];
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
      .gt("stability", 5) // arbitrary "I clearly know this" threshold
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

  // Recent lesson vocab — newest household vocab regardless of whether the
  // user has graded it yet. Drop entries that already appear in `known`.
  const recent: ChatVocabContextItem[] = [];
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

  // Mistake history: most-recent chat corrections first, then top up from
  // the household teacher corrections so a brand-new chatter still benefits
  // from prior lesson feedback.
  const corrections: ChatCorrectionHistoryItem[] = [];
  const { data: chatCorrections, error: chatCorrectionError } = await supabase
    .from("chat_corrections")
    .select("source_text, corrected_text, kind, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(correctionLimit);
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

  const parsedLevel = ChatLevelSchema.safeParse(session.level);
  const level: ChatLevel = parsedLevel.success ? parsedLevel.data : "beginner";

  return {
    level,
    knownVocab: known,
    recentLessonVocab: recent,
    recentCorrections: corrections,
    rollingSummary: session.summary,
  };
}
