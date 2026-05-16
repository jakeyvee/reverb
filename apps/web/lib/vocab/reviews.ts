import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, TablesInsert, TablesUpdate } from "@reverb/db/types";
import { ReviewRatingSchema, type ReviewRating } from "@reverb/domain/schemas/review";
import {
  newStoredCard,
  scheduleStoredReview,
  type StoredCardSnapshot,
} from "@reverb/srs";

export type DueVocabCard = {
  cardId: string;
  vocabItemId: string;
  state: StoredCardSnapshot["state"];
  dueAt: string;
  reps: number;
  lapses: number;
  vocab: {
    lemma: string;
    reading: string | null;
    translation: string | null;
    partOfSpeech: string | null;
    exampleSentence: string | null;
    exampleTranslation: string | null;
    lessonId: string | null;
    audioStorageBucket: string | null;
    audioStoragePath: string | null;
  };
};

export type LoadDueCardsOptions = {
  now?: Date;
  limit?: number;
};

const DEFAULT_DUE_LIMIT = 20;

// Fetches every vocab card the user has scheduled for or before `now`,
// ordered by oldest-due first. RLS scopes this query to the caller's own
// cards rows — we still pass `user_id` so the index is used and the intent
// is unambiguous in logs.
export async function loadDueVocabCards(
  supabase: SupabaseClient<Database>,
  userId: string,
  options: LoadDueCardsOptions = {},
): Promise<DueVocabCard[]> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? DEFAULT_DUE_LIMIT;

  const { data, error } = await supabase
    .from("cards")
    .select(
      "id, vocab_item_id, state, due_at, reps, lapses, vocab_item:vocab_items!inner(lemma, reading, translation, part_of_speech, example_sentence, example_translation, lesson_id, audio_storage_bucket, audio_storage_path)",
    )
    .eq("user_id", userId)
    .lte("due_at", now.toISOString())
    .order("due_at", { ascending: true })
    .limit(limit);
  if (error) {
    throw new Error(`Could not load due vocab cards: ${error.message}`);
  }

  return (data ?? []).map((row) => {
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
}

// Returns the card row for a vocab item, materialising one with FSRS
// defaults if the user hasn't started studying that item yet. Lets the
// session UI flip "fresh vocab" into "due now" lazily without a separate
// admin step. RLS guarantees we can only touch the caller's own rows.
export type EnsureCardResult = {
  cardId: string;
  created: boolean;
};

export async function ensureCardForVocabItem(
  supabase: SupabaseClient<Database>,
  userId: string,
  vocabItemId: string,
  now: Date = new Date(),
): Promise<EnsureCardResult> {
  const { data: existing, error: existingError } = await supabase
    .from("cards")
    .select("id")
    .eq("user_id", userId)
    .eq("vocab_item_id", vocabItemId)
    .maybeSingle();
  if (existingError) {
    throw new Error(`Could not look up card: ${existingError.message}`);
  }
  if (existing) return { cardId: existing.id, created: false };

  const insertRow: TablesInsert<"cards"> = {
    user_id: userId,
    vocab_item_id: vocabItemId,
    ...newStoredCard(now),
  };
  // upsert + ignoreDuplicates to make this race-safe against double-clicks
  // and parallel tab loads. Mirrors the correction-drills bootstrap pattern.
  const { data: inserted, error: insertError } = await supabase
    .from("cards")
    .upsert(insertRow, { onConflict: "user_id,vocab_item_id", ignoreDuplicates: true })
    .select("id")
    .maybeSingle();
  if (insertError) {
    throw new Error(`Could not create card: ${insertError.message}`);
  }
  if (inserted) return { cardId: inserted.id, created: true };

  // ignoreDuplicates returns no row when another writer beat us; re-read.
  const { data: rebound, error: reboundError } = await supabase
    .from("cards")
    .select("id")
    .eq("user_id", userId)
    .eq("vocab_item_id", vocabItemId)
    .maybeSingle();
  if (reboundError || !rebound) {
    throw new Error(`Could not load card after upsert: ${reboundError?.message ?? "missing"}`);
  }
  return { cardId: rebound.id, created: false };
}

export type SubmitVocabReviewInput = {
  cardId: string;
  rating: ReviewRating;
  elapsedMs?: number;
};

export type SubmitVocabReviewOutput = {
  cardId: string;
  state: StoredCardSnapshot["state"];
  dueAt: string;
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
};

// Single trip from "user picked Again/Hard/Good/Easy" to "card row updated
// + audit row appended". Steps:
//   1. Load the card row (RLS-scoped to the caller).
//   2. Run FSRS to compute the next state.
//   3. Update `cards` with the new state/due_at/stability/etc.
//   4. Insert an append-only `card_reviews` row with previous + next state.
//
// We let RLS do the user-scoping; the explicit `user_id = userId` clauses
// keep the indices happy and make the intent obvious to readers.
export async function submitVocabReview(
  supabase: SupabaseClient<Database>,
  userId: string,
  input: SubmitVocabReviewInput,
  now: Date = new Date(),
): Promise<SubmitVocabReviewOutput> {
  const { data: card, error: cardError } = await supabase
    .from("cards")
    .select(
      "id, user_id, vocab_item_id, state, due_at, stability, difficulty, reps, lapses, scheduled_days, elapsed_days, last_reviewed_at",
    )
    .eq("id", input.cardId)
    .eq("user_id", userId)
    .maybeSingle();
  if (cardError) {
    throw new Error(`Could not load card: ${cardError.message}`);
  }
  if (!card) {
    throw new Error("Card not found.");
  }

  const scheduled = scheduleStoredReview({
    card: {
      state: card.state,
      due_at: card.due_at,
      stability: card.stability,
      difficulty: card.difficulty,
      reps: card.reps,
      lapses: card.lapses,
      scheduled_days: card.scheduled_days,
      elapsed_days: card.elapsed_days,
      last_reviewed_at: card.last_reviewed_at,
    },
    rating: input.rating,
    now,
  });

  const update: TablesUpdate<"cards"> = scheduled.next;
  const { error: updateError } = await supabase
    .from("cards")
    .update(update)
    .eq("id", card.id)
    .eq("user_id", userId);
  if (updateError) {
    throw new Error(`Could not update card: ${updateError.message}`);
  }

  // Append-only history. We never UPDATE these rows — every grade gets its
  // own audit entry, with both the pre- and post-review state captured so
  // future analytics can reconstruct the curve without replaying FSRS.
  const reviewRow: TablesInsert<"card_reviews"> = {
    card_id: card.id,
    user_id: userId,
    rating: input.rating,
    elapsed_ms: input.elapsedMs ?? null,
    reviewed_at: scheduled.reviewedAt.toISOString(),
    previous_state: scheduled.previous.state,
    previous_stability: scheduled.previous.stability,
    previous_difficulty: scheduled.previous.difficulty,
    next_state: scheduled.next.state,
    next_stability: scheduled.next.stability,
    next_difficulty: scheduled.next.difficulty,
    next_due_at: scheduled.next.due_at,
  };
  const { error: insertError } = await supabase.from("card_reviews").insert(reviewRow);
  if (insertError) {
    throw new Error(`Could not record review: ${insertError.message}`);
  }

  return {
    cardId: card.id,
    state: scheduled.next.state,
    dueAt: scheduled.next.due_at,
    stability: scheduled.next.stability,
    difficulty: scheduled.next.difficulty,
    reps: scheduled.next.reps,
    lapses: scheduled.next.lapses,
  };
}

export { ReviewRatingSchema };
