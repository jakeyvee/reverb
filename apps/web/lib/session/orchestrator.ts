import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Tables, TablesInsert } from "@reverb/db/types";
import { classifyCorrectionConfidence } from "@reverb/domain/schemas/correction-drill";
import { loadDueVocabReviewCards, type ReviewableVocabCard } from "./vocab-review";
import type { CorrectionDrillView } from "./correction-drills";
import { ensureCorrectionDrillsForUser } from "./correction-drills";

// VOL-121: Daily session orchestrator.
//
// One button starts today's mixed session (mistake drills first, vocab
// reviews behind them). The queue is materialised once and persisted into
// `practice_session_items`, so a refresh, second tab, or mobile → laptop
// hand-off keeps the same items in the same order and the same answered
// state. Adding a future item kind (grammar exercise, shadowing) only needs
//   (a) a `kind` value the assembler knows about,
//   (b) a way to load source rows for it,
//   (c) a runner in the UI;
// the session contract — one ordered list of items with answered_at /
// rating / correct columns — does not change.

const DEFAULT_DRILL_LIMIT = 8;
const DEFAULT_VOCAB_LIMIT = 12;

export const VOCAB_REVIEW_XP_PER_GOOD_RATING = 3;
// Vocab is awarded by rating. Again rates 0 because the user got it wrong;
// every other answer is a successful recall worth its rating's tier of XP.
const VOCAB_XP_BY_RATING = {
  again: 0,
  hard: 2,
  good: VOCAB_REVIEW_XP_PER_GOOD_RATING,
  easy: 4,
} as const;

export function xpForVocabRating(rating: keyof typeof VOCAB_XP_BY_RATING): number {
  return VOCAB_XP_BY_RATING[rating];
}

// Pure assembly of the queue order. Pulled out so the rule (mistake drills
// always slot ahead of vocab, ordering inside each kind is preserved from
// the loader) lives in one testable place.
export type AssembledItem =
  | { kind: "mistake_drill"; correctionDrillId: string }
  | { kind: "card"; cardId: string };

export function assembleSessionQueue(args: {
  corrections: ReadonlyArray<{ drillId: string }>;
  vocabCards: ReadonlyArray<{ cardId: string }>;
}): AssembledItem[] {
  return [
    ...args.corrections.map<AssembledItem>((drill) => ({
      kind: "mistake_drill",
      correctionDrillId: drill.drillId,
    })),
    ...args.vocabCards.map<AssembledItem>((card) => ({
      kind: "card",
      cardId: card.cardId,
    })),
  ];
}

// Hydrated session view returned to the UI. Each item carries the data the
// runner needs to render it without an extra round-trip. `completed` is
// computed from `answered_at` so a refresh resumes mid-queue without
// re-asking the user to answer something they already finished.
export type SessionItem =
  | {
      sessionItemId: string;
      position: number;
      kind: "mistake_drill";
      completed: boolean;
      drill: CorrectionDrillView;
    }
  | {
      sessionItemId: string;
      position: number;
      kind: "card";
      completed: boolean;
      card: ReviewableVocabCard;
    };

export type DailySessionView = {
  sessionId: string;
  status: Tables<"practice_sessions">["status"];
  startedAt: string;
  endedAt: string | null;
  xpEarned: number;
  cardsReviewed: number;
  exercisesAttempted: number;
  items: SessionItem[];
  // Items the orchestrator skipped because they reference rows that have
  // since been deleted (e.g. drill retired + correction removed). Counted
  // separately so the UI can mention them without breaking the queue.
  unresolvedItems: number;
};

export type StartOrResumeOptions = {
  now?: Date;
  drillLimit?: number;
  vocabLimit?: number;
};

// Entry point for the /session page and the "Start Today's Session" CTA.
//
// Steps:
//   1. Look up today's active session for the user. If one exists, hydrate
//      it and return — the user is resuming.
//   2. Otherwise, materialise correction drills (lazy projection), assemble
//      the queue, insert the practice_sessions row and its items, append a
//      `session_start` event, and return the hydrated view.
//
// "Today" is bracketed by UTC midnight. Supporting per-user timezones is a
// pure win once we surface a profile-level setting, but the streak roll-up
// already uses UTC so we stay consistent here.
export async function startOrResumeTodaysSession(
  supabase: SupabaseClient<Database>,
  userId: string,
  options: StartOrResumeOptions = {},
): Promise<DailySessionView> {
  const now = options.now ?? new Date();
  const dayStart = startOfUtcDay(now).toISOString();
  const dayEnd = endOfUtcDay(now).toISOString();

  const existing = await findActiveSessionForDay(supabase, userId, dayStart, dayEnd);
  if (existing) {
    const hydrated = await hydrateSession(supabase, userId, existing);
    // If today's session never managed to seed any items (the user opened
    // the app before lessons produced anything), top it up the next time
    // around so a single tap isn't stuck on "Nothing due right now". We
    // append rather than replace so any answered items from the original
    // queue stay in place.
    if (hydrated.items.length === 0 && hydrated.unresolvedItems === 0) {
      await ensureCorrectionDrillsForUser(supabase, userId);
      const { drills, vocabCards } = await loadCandidateQueue(supabase, userId, {
        now,
        drillLimit: options.drillLimit ?? DEFAULT_DRILL_LIMIT,
        vocabLimit: options.vocabLimit ?? DEFAULT_VOCAB_LIMIT,
      });
      const assembled = assembleSessionQueue({
        corrections: drills.map((d) => ({ drillId: d.drillId })),
        vocabCards: vocabCards.map((c) => ({ cardId: c.cardId })),
      });
      if (assembled.length > 0) {
        const itemRows: TablesInsert<"practice_session_items">[] = assembled.map((item, index) => ({
          session_id: existing.id,
          user_id: userId,
          position: index,
          kind: item.kind,
          card_id: item.kind === "card" ? item.cardId : null,
          correction_drill_id: item.kind === "mistake_drill" ? item.correctionDrillId : null,
        }));
        const { error } = await supabase.from("practice_session_items").insert(itemRows);
        if (error) {
          throw new Error(`Could not top up practice_session_items: ${error.message}`);
        }
        return hydrateSession(supabase, userId, existing);
      }
    }
    return hydrated;
  }

  // The lazy projection pattern: drills don't exist until the user opens
  // their session for the first time. Mirrors `/session/page.tsx`'s prior
  // behaviour so the orchestrator is a drop-in replacement.
  await ensureCorrectionDrillsForUser(supabase, userId);

  const { drills, vocabCards } = await loadCandidateQueue(supabase, userId, {
    now,
    drillLimit: options.drillLimit ?? DEFAULT_DRILL_LIMIT,
    vocabLimit: options.vocabLimit ?? DEFAULT_VOCAB_LIMIT,
  });

  const assembled = assembleSessionQueue({
    corrections: drills.map((d) => ({ drillId: d.drillId })),
    vocabCards: vocabCards.map((c) => ({ cardId: c.cardId })),
  });

  const sessionRow: TablesInsert<"practice_sessions"> = {
    user_id: userId,
    status: "active",
    started_at: now.toISOString(),
  };
  const { data: insertedSession, error: sessionError } = await supabase
    .from("practice_sessions")
    .insert(sessionRow)
    .select("id, status, started_at, ended_at, xp_earned, cards_reviewed, exercises_attempted")
    .maybeSingle();
  if (sessionError || !insertedSession) {
    // Concurrent tab race: the partial unique index makes the second insert
    // fail with code 23505. Re-read the row we lost the race to and hydrate
    // that one instead of throwing.
    const rebound = await findActiveSessionForDay(supabase, userId, dayStart, dayEnd);
    if (rebound) return hydrateSession(supabase, userId, rebound);
    throw new Error(`Could not create practice_session: ${sessionError?.message ?? "no row"}`);
  }

  if (assembled.length > 0) {
    const itemRows: TablesInsert<"practice_session_items">[] = assembled.map((item, index) => ({
      session_id: insertedSession.id,
      user_id: userId,
      position: index,
      kind: item.kind,
      card_id: item.kind === "card" ? item.cardId : null,
      correction_drill_id: item.kind === "mistake_drill" ? item.correctionDrillId : null,
    }));
    const { error: itemsError } = await supabase.from("practice_session_items").insert(itemRows);
    if (itemsError) {
      throw new Error(`Could not seed practice_session_items: ${itemsError.message}`);
    }
  }

  await appendPracticeEvent(supabase, userId, {
    session_id: insertedSession.id,
    kind: "session_start",
    payload: { item_count: assembled.length, source: "daily_orchestrator" },
  });

  return hydrateSession(supabase, userId, insertedSession);
}

type ActiveSessionRow = {
  id: string;
  status: Tables<"practice_sessions">["status"];
  started_at: string;
  ended_at: string | null;
  xp_earned: number;
  cards_reviewed: number;
  exercises_attempted: number;
};

async function findActiveSessionForDay(
  supabase: SupabaseClient<Database>,
  userId: string,
  dayStart: string,
  dayEnd: string,
): Promise<ActiveSessionRow | null> {
  const { data, error } = await supabase
    .from("practice_sessions")
    .select("id, status, started_at, ended_at, xp_earned, cards_reviewed, exercises_attempted")
    .eq("user_id", userId)
    .eq("status", "active")
    .gte("started_at", dayStart)
    .lt("started_at", dayEnd)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not look up today's session: ${error.message}`);
  }
  return data ?? null;
}

async function loadCandidateQueue(
  supabase: SupabaseClient<Database>,
  userId: string,
  args: { now: Date; drillLimit: number; vocabLimit: number },
): Promise<{ drills: CorrectionDrillView[]; vocabCards: ReviewableVocabCard[] }> {
  const nowIso = args.now.toISOString();
  const [drillResp, vocab] = await Promise.all([
    supabase
      .from("correction_drills")
      .select(
        "id, state, due_at, attempts, passes, fails, consecutive_passes, xp_earned, teacher_correction:teacher_corrections!inner(id, kind, source_text, corrected_text, explanation, confidence, lesson_id)",
      )
      .eq("user_id", userId)
      .neq("state", "retired")
      .lte("due_at", nowIso)
      .order("due_at", { ascending: true })
      .limit(args.drillLimit * 2),
    loadDueVocabReviewCards(supabase, userId, { now: args.now, limit: args.vocabLimit }),
  ]);
  if (drillResp.error) {
    throw new Error(`Could not load drill candidates: ${drillResp.error.message}`);
  }
  const drills: CorrectionDrillView[] = [];
  for (const row of drillResp.data ?? []) {
    const correction = Array.isArray(row.teacher_correction)
      ? row.teacher_correction[0]
      : row.teacher_correction;
    if (!correction) continue;
    const tier = classifyCorrectionConfidence(correction.confidence);
    if (tier === "ineligible") continue;
    if (drills.length >= args.drillLimit) break;
    drills.push({
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
  return { drills, vocabCards: vocab };
}

// Hydrate a session row + its items into the view model the UI consumes.
// Items missing their target row (drill or card was deleted between
// assembly and hydration) are dropped from the queue but counted in
// `unresolvedItems` so the UI can tell the user about them.
async function hydrateSession(
  supabase: SupabaseClient<Database>,
  userId: string,
  session: ActiveSessionRow,
): Promise<DailySessionView> {
  const { data: itemRows, error: itemsError } = await supabase
    .from("practice_session_items")
    .select(
      "id, position, kind, card_id, correction_drill_id, answered_at, rating, correct, response_ms",
    )
    .eq("session_id", session.id)
    .order("position", { ascending: true });
  if (itemsError) {
    throw new Error(`Could not load session items: ${itemsError.message}`);
  }
  const rows = itemRows ?? [];
  const drillIds: string[] = [];
  const cardIds: string[] = [];
  for (const row of rows) {
    if (row.kind === "mistake_drill" && row.correction_drill_id) {
      drillIds.push(row.correction_drill_id);
    } else if (row.kind === "card" && row.card_id) {
      cardIds.push(row.card_id);
    }
  }

  const [drillsById, cardsById] = await Promise.all([
    drillIds.length > 0 ? loadDrillsByIds(supabase, userId, drillIds) : new Map(),
    cardIds.length > 0 ? loadCardsByIds(supabase, userId, cardIds) : new Map(),
  ]);

  const items: SessionItem[] = [];
  let unresolved = 0;
  for (const row of rows) {
    if (row.kind === "mistake_drill") {
      const drill = row.correction_drill_id ? drillsById.get(row.correction_drill_id) : undefined;
      if (!drill) {
        unresolved += 1;
        continue;
      }
      items.push({
        sessionItemId: row.id,
        position: row.position,
        kind: "mistake_drill",
        completed: row.answered_at !== null,
        drill,
      });
    } else if (row.kind === "card") {
      const card = row.card_id ? cardsById.get(row.card_id) : undefined;
      if (!card) {
        unresolved += 1;
        continue;
      }
      items.push({
        sessionItemId: row.id,
        position: row.position,
        kind: "card",
        completed: row.answered_at !== null,
        card,
      });
    } else {
      // Unknown kind (grammar_exercise / dialogue_clip placeholders). The
      // orchestrator currently emits only `card` and `mistake_drill`, so an
      // unknown row is data drift — drop it from the queue rather than
      // failing the whole page.
      unresolved += 1;
    }
  }

  return {
    sessionId: session.id,
    status: session.status,
    startedAt: session.started_at,
    endedAt: session.ended_at,
    xpEarned: session.xp_earned,
    cardsReviewed: session.cards_reviewed,
    exercisesAttempted: session.exercises_attempted,
    items,
    unresolvedItems: unresolved,
  };
}

async function loadDrillsByIds(
  supabase: SupabaseClient<Database>,
  userId: string,
  ids: string[],
): Promise<Map<string, CorrectionDrillView>> {
  const { data, error } = await supabase
    .from("correction_drills")
    .select(
      "id, state, due_at, attempts, passes, fails, consecutive_passes, xp_earned, teacher_correction:teacher_corrections!inner(id, kind, source_text, corrected_text, explanation, confidence, lesson_id)",
    )
    .eq("user_id", userId)
    .in("id", ids);
  if (error) {
    throw new Error(`Could not load session drill items: ${error.message}`);
  }
  const out = new Map<string, CorrectionDrillView>();
  for (const row of data ?? []) {
    const correction = Array.isArray(row.teacher_correction)
      ? row.teacher_correction[0]
      : row.teacher_correction;
    if (!correction) continue;
    out.set(row.id, {
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
      confidenceTier: classifyCorrectionConfidence(correction.confidence),
    });
  }
  return out;
}

async function loadCardsByIds(
  supabase: SupabaseClient<Database>,
  userId: string,
  ids: string[],
): Promise<Map<string, ReviewableVocabCard>> {
  const { data, error } = await supabase
    .from("cards")
    .select(
      "id, vocab_item_id, state, due_at, reps, lapses, vocab_item:vocab_items!inner(lemma, reading, translation, part_of_speech, example_sentence, example_translation, lesson_id, audio_storage_bucket, audio_storage_path)",
    )
    .eq("user_id", userId)
    .in("id", ids);
  if (error) {
    throw new Error(`Could not load session vocab items: ${error.message}`);
  }
  const out = new Map<string, ReviewableVocabCard>();
  // Resolving audio + lesson titles per card. Mirrors loadDueVocabReviewCards
  // — duplicated here so we only sign URLs for the cards still in the queue
  // (a refresh after answering 6/10 vocab cards shouldn't issue 10 storage
  // signs).
  const baseCards = (data ?? []).map((row) => {
    const vocab = Array.isArray(row.vocab_item) ? row.vocab_item[0] : row.vocab_item;
    return {
      cardId: row.id,
      vocabItemId: row.vocab_item_id,
      state: row.state,
      dueAt: row.due_at,
      reps: row.reps,
      lapses: row.lapses,
      vocab: {
        lemma: vocab?.lemma ?? "",
        reading: vocab?.reading ?? null,
        translation: vocab?.translation ?? null,
        partOfSpeech: vocab?.part_of_speech ?? null,
        exampleSentence: vocab?.example_sentence ?? null,
        exampleTranslation: vocab?.example_translation ?? null,
        lessonId: vocab?.lesson_id ?? null,
        audioStorageBucket: vocab?.audio_storage_bucket ?? null,
        audioStoragePath: vocab?.audio_storage_path ?? null,
      },
    };
  });
  const [audioByCard, lessonTitleById] = await Promise.all([
    resolveAudioForCards(supabase, baseCards),
    resolveLessonTitles(supabase, baseCards),
  ]);
  for (const base of baseCards) {
    out.set(base.cardId, {
      ...base,
      audioUrl: audioByCard.get(base.cardId) ?? null,
      lessonTitle: base.vocab.lessonId ? (lessonTitleById.get(base.vocab.lessonId) ?? null) : null,
    });
  }
  return out;
}

const SUPPORTED_AUDIO_BUCKETS = new Set(["tts-cache", "lesson-clips"]);
const AUDIO_SIGNED_URL_TTL_SECONDS = 60 * 10;

async function resolveAudioForCards(
  supabase: SupabaseClient<Database>,
  cards: ReadonlyArray<{
    cardId: string;
    vocab: { audioStorageBucket: string | null; audioStoragePath: string | null };
  }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const results = await Promise.all(
    cards.map(async (card) => {
      const bucket = card.vocab.audioStorageBucket;
      const path = card.vocab.audioStoragePath;
      if (!bucket || !path) return null;
      if (!SUPPORTED_AUDIO_BUCKETS.has(bucket)) return null;
      const { data, error } = await supabase.storage
        .from(bucket)
        .createSignedUrl(path, AUDIO_SIGNED_URL_TTL_SECONDS);
      if (error || !data?.signedUrl) return null;
      return { cardId: card.cardId, url: data.signedUrl };
    }),
  );
  for (const result of results) {
    if (result) out.set(result.cardId, result.url);
  }
  return out;
}

async function resolveLessonTitles(
  supabase: SupabaseClient<Database>,
  cards: ReadonlyArray<{ vocab: { lessonId: string | null } }>,
): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const card of cards) {
    if (card.vocab.lessonId) ids.add(card.vocab.lessonId);
  }
  if (ids.size === 0) return new Map();
  const { data, error } = await supabase
    .from("lessons")
    .select("id, title")
    .in("id", Array.from(ids));
  if (error || !data) return new Map();
  return new Map(data.map((row) => [row.id, row.title] as const));
}

// Append a practice_events row. RLS already self-scopes; we pass user_id
// explicitly so the request is unambiguous in service-role contexts too.
type PracticeEventInput = Omit<TablesInsert<"practice_events">, "user_id">;

async function appendPracticeEvent(
  supabase: SupabaseClient<Database>,
  userId: string,
  event: PracticeEventInput,
): Promise<void> {
  const row: TablesInsert<"practice_events"> = { ...event, user_id: userId };
  const { error } = await supabase.from("practice_events").insert(row);
  if (error) {
    // We don't want the event log to brick the user-visible action, but we
    // also don't want the log to silently drop forever — surface it to the
    // console so a follow-up pass can wire structured telemetry.
    console.warn("practice_events insert failed", error.message);
  }
}

// ---- Per-item update + completion -------------------------------------

export type RecordItemAnswerInput = {
  sessionItemId: string;
  correct: boolean | null;
  rating?: Database["public"]["Enums"]["review_rating"] | null;
  responseMs?: number | null;
  xpAwarded: number;
  // `card` rows count toward cards_reviewed; everything else toward
  // exercises_attempted. The orchestrator is the single writer for these
  // counters so we keep the bookkeeping in one place.
  bucket: "card" | "exercise";
};

export type RecordItemAnswerResult = {
  alreadyAnswered: boolean;
  sessionXpEarned: number;
  cardsReviewed: number;
  exercisesAttempted: number;
};

// Records a single item answer against an existing session. Idempotent: if
// the item has already been answered (double-submit, slow network retry)
// this returns the current session counters without re-incrementing them.
// Must be called for items that belong to the caller — RLS enforces that.
export async function recordSessionItemAnswer(
  supabase: SupabaseClient<Database>,
  userId: string,
  input: RecordItemAnswerInput,
  now: Date = new Date(),
): Promise<RecordItemAnswerResult> {
  const { data: item, error: itemError } = await supabase
    .from("practice_session_items")
    .select("id, session_id, answered_at")
    .eq("id", input.sessionItemId)
    .eq("user_id", userId)
    .maybeSingle();
  if (itemError) {
    throw new Error(`Could not load session item: ${itemError.message}`);
  }
  if (!item) {
    throw new Error("Session item not found.");
  }

  if (item.answered_at !== null) {
    const { data: session } = await supabase
      .from("practice_sessions")
      .select("xp_earned, cards_reviewed, exercises_attempted")
      .eq("id", item.session_id)
      .eq("user_id", userId)
      .maybeSingle();
    return {
      alreadyAnswered: true,
      sessionXpEarned: session?.xp_earned ?? 0,
      cardsReviewed: session?.cards_reviewed ?? 0,
      exercisesAttempted: session?.exercises_attempted ?? 0,
    };
  }

  const { error: updateError } = await supabase
    .from("practice_session_items")
    .update({
      answered_at: now.toISOString(),
      correct: input.correct,
      rating: input.rating ?? null,
      response_ms: input.responseMs ?? null,
    })
    .eq("id", item.id)
    .eq("user_id", userId);
  if (updateError) {
    throw new Error(`Could not update session item: ${updateError.message}`);
  }

  // Load the session counters and bump them with a single update. We pick
  // read-then-update over an RPC because:
  //   (a) we want to return the new counters to the caller in the same
  //       round-trip the UI is already waiting on, and
  //   (b) the partial unique index + RLS make a race here harmless: the
  //       worst case is one tab over-counts an item the other tab is also
  //       in the middle of recording. The idempotency guard at the top of
  //       this function makes that exceedingly unlikely in practice.
  const { data: session, error: sessionError } = await supabase
    .from("practice_sessions")
    .select("xp_earned, cards_reviewed, exercises_attempted")
    .eq("id", item.session_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (sessionError || !session) {
    throw new Error(`Could not load session counters: ${sessionError?.message ?? "missing"}`);
  }

  const nextXp = session.xp_earned + Math.max(0, input.xpAwarded);
  const nextCardsReviewed = session.cards_reviewed + (input.bucket === "card" ? 1 : 0);
  const nextExercisesAttempted =
    session.exercises_attempted + (input.bucket === "exercise" ? 1 : 0);

  const { error: bumpError } = await supabase
    .from("practice_sessions")
    .update({
      xp_earned: nextXp,
      cards_reviewed: nextCardsReviewed,
      exercises_attempted: nextExercisesAttempted,
    })
    .eq("id", item.session_id)
    .eq("user_id", userId);
  if (bumpError) {
    throw new Error(`Could not update session counters: ${bumpError.message}`);
  }

  await appendPracticeEvent(supabase, userId, {
    session_id: item.session_id,
    session_item_id: item.id,
    kind: "item_answered",
    occurred_at: now.toISOString(),
    payload: {
      correct: input.correct,
      rating: input.rating ?? null,
      response_ms: input.responseMs ?? null,
      xp_awarded: input.xpAwarded,
      bucket: input.bucket,
    },
  });

  return {
    alreadyAnswered: false,
    sessionXpEarned: nextXp,
    cardsReviewed: nextCardsReviewed,
    exercisesAttempted: nextExercisesAttempted,
  };
}

export type CompleteSessionResult = {
  status: "completed" | "already_completed" | "no_items";
  sessionId: string;
  xpEarned: number;
  cardsReviewed: number;
  exercisesAttempted: number;
  durationMs: number;
  streak: {
    currentLength: number;
    longestLength: number;
    lastPracticedOn: string | null;
    bumped: boolean;
  };
};

// Finalises a session: marks it completed, computes duration, appends the
// `session_complete` event, and bumps the streak if the user hadn't already
// practised today. Idempotent for double-clicks: a completed session round-
// trips with status "already_completed" and the existing counters.
export async function completeSession(
  supabase: SupabaseClient<Database>,
  userId: string,
  sessionId: string,
  now: Date = new Date(),
): Promise<CompleteSessionResult> {
  const { data: session, error: sessionError } = await supabase
    .from("practice_sessions")
    .select(
      "id, status, started_at, ended_at, duration_ms, xp_earned, cards_reviewed, exercises_attempted",
    )
    .eq("id", sessionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (sessionError) {
    throw new Error(`Could not load session: ${sessionError.message}`);
  }
  if (!session) {
    throw new Error("Session not found.");
  }

  if (session.status === "completed") {
    const streak = await readStreak(supabase, userId);
    return {
      status: "already_completed",
      sessionId: session.id,
      xpEarned: session.xp_earned,
      cardsReviewed: session.cards_reviewed,
      exercisesAttempted: session.exercises_attempted,
      durationMs: session.duration_ms ?? 0,
      streak: { ...streak, bumped: false },
    };
  }

  // Refuse to finalise a session that has open items — that would silently
  // bury work the user can still come back to. The UI only calls complete()
  // after every item is answered, so this is a guard against bad callers.
  const { count: openItems } = await supabase
    .from("practice_session_items")
    .select("id", { count: "exact", head: true })
    .eq("session_id", session.id)
    .eq("user_id", userId)
    .is("answered_at", null);
  if ((openItems ?? 0) > 0) {
    throw new Error("Cannot complete a session with unanswered items.");
  }

  const startedAt = new Date(session.started_at).getTime();
  const durationMs = Math.max(0, now.getTime() - startedAt);

  const { error: updateError } = await supabase
    .from("practice_sessions")
    .update({
      status: "completed",
      ended_at: now.toISOString(),
      duration_ms: durationMs,
    })
    .eq("id", session.id)
    .eq("user_id", userId);
  if (updateError) {
    throw new Error(`Could not complete session: ${updateError.message}`);
  }

  await appendPracticeEvent(supabase, userId, {
    session_id: session.id,
    kind: "session_complete",
    occurred_at: now.toISOString(),
    payload: {
      xp_earned: session.xp_earned,
      cards_reviewed: session.cards_reviewed,
      exercises_attempted: session.exercises_attempted,
      duration_ms: durationMs,
    },
  });

  const streak = await bumpStreakForToday(supabase, userId, now);

  return {
    status: session.cards_reviewed + session.exercises_attempted === 0 ? "no_items" : "completed",
    sessionId: session.id,
    xpEarned: session.xp_earned,
    cardsReviewed: session.cards_reviewed,
    exercisesAttempted: session.exercises_attempted,
    durationMs,
    streak,
  };
}

type StreakSnapshot = {
  currentLength: number;
  longestLength: number;
  lastPracticedOn: string | null;
};

async function readStreak(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<StreakSnapshot> {
  const { data } = await supabase
    .from("streaks")
    .select("current_length, longest_length, last_practiced_on")
    .eq("user_id", userId)
    .maybeSingle();
  return {
    currentLength: data?.current_length ?? 0,
    longestLength: data?.longest_length ?? 0,
    lastPracticedOn: data?.last_practiced_on ?? null,
  };
}

// Bumps the streak row for "the user practised today". UTC date for now —
// the streaks table carries a timezone column for a future per-user pass.
// Idempotent: if the user already finished a session today, the streak
// row is read but not advanced.
async function bumpStreakForToday(
  supabase: SupabaseClient<Database>,
  userId: string,
  now: Date,
): Promise<StreakSnapshot & { bumped: boolean }> {
  const today = formatUtcDay(now);

  const { data: existing } = await supabase
    .from("streaks")
    .select("current_length, longest_length, last_practiced_on")
    .eq("user_id", userId)
    .maybeSingle();

  if (!existing) {
    const { data: inserted, error } = await supabase
      .from("streaks")
      .upsert(
        {
          user_id: userId,
          current_length: 1,
          longest_length: 1,
          last_practiced_on: today,
        },
        { onConflict: "user_id", ignoreDuplicates: false },
      )
      .select("current_length, longest_length, last_practiced_on")
      .maybeSingle();
    if (error) {
      // Don't fail completion on a streak write — return the implied state.
      return { currentLength: 1, longestLength: 1, lastPracticedOn: today, bumped: true };
    }
    return {
      currentLength: inserted?.current_length ?? 1,
      longestLength: inserted?.longest_length ?? 1,
      lastPracticedOn: inserted?.last_practiced_on ?? today,
      bumped: true,
    };
  }

  if (existing.last_practiced_on === today) {
    return {
      currentLength: existing.current_length,
      longestLength: existing.longest_length,
      lastPracticedOn: existing.last_practiced_on,
      bumped: false,
    };
  }

  const yesterday = formatUtcDay(new Date(now.getTime() - 86_400_000));
  const continued = existing.last_practiced_on === yesterday;
  const nextLength = continued ? existing.current_length + 1 : 1;
  const nextLongest = Math.max(existing.longest_length, nextLength);

  const { data: bumped, error } = await supabase
    .from("streaks")
    .update({
      current_length: nextLength,
      longest_length: nextLongest,
      last_practiced_on: today,
    })
    .eq("user_id", userId)
    .select("current_length, longest_length, last_practiced_on")
    .maybeSingle();
  if (error) {
    return {
      currentLength: nextLength,
      longestLength: nextLongest,
      lastPracticedOn: today,
      bumped: true,
    };
  }
  return {
    currentLength: bumped?.current_length ?? nextLength,
    longestLength: bumped?.longest_length ?? nextLongest,
    lastPracticedOn: bumped?.last_practiced_on ?? today,
    bumped: true,
  };
}

function startOfUtcDay(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function endOfUtcDay(now: Date): Date {
  const d = startOfUtcDay(now);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

function formatUtcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}
