"use server";

import { z } from "zod";
import { ReviewRatingSchema, type ReviewRating } from "@reverb/domain/schemas/review";
import { requireUser } from "@/lib/auth/get-user";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  ensureCardForVocabItem,
  loadDueVocabCards,
  submitVocabReview,
  type DueVocabCard,
  type SubmitVocabReviewOutput,
} from "./reviews";
import { recordSessionItemAnswer, xpForVocabRating } from "@/lib/session/orchestrator";

const SubmitInputSchema = z.object({
  cardId: z.string().uuid(),
  rating: ReviewRatingSchema,
  elapsedMs: z.number().int().nonnegative().optional(),
  // Optional link back to the practice_session_items row this review was
  // served from. When provided, the action also bumps the session counters
  // + appends an item_answered event in the same round-trip. Outside-of-
  // session reviews (e.g. a future "extra practice" panel) omit it.
  sessionItemId: z.string().uuid().optional(),
});

export type SubmitVocabReviewActionInput = z.infer<typeof SubmitInputSchema>;

export type SubmitVocabReviewActionResult =
  | {
      ok: true;
      review: SubmitVocabReviewOutput;
      session?: {
        sessionItemId: string;
        sessionXpEarned: number;
        cardsReviewed: number;
        exercisesAttempted: number;
        xpAwarded: number;
      };
    }
  | { ok: false; error: string };

// Server action the session UI hits when the user picks Again/Hard/Good/Easy.
// Returns the updated card snapshot so the client can advance to the next
// drill without a refetch.
export async function submitVocabReviewAction(
  input: SubmitVocabReviewActionInput,
): Promise<SubmitVocabReviewActionResult> {
  const parsed = SubmitInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Invalid request." };
  }

  const user = await requireUser();
  const supabase = await createServerSupabaseClient();
  if (!supabase) {
    return { ok: false, error: "Supabase is not configured for this environment." };
  }

  try {
    const review = await submitVocabReview(supabase, user.id, parsed.data);
    let sessionSnapshot: Extract<SubmitVocabReviewActionResult, { ok: true }>["session"];
    if (parsed.data.sessionItemId) {
      const xpAwarded = xpForVocabRating(parsed.data.rating);
      try {
        const recorded = await recordSessionItemAnswer(supabase, user.id, {
          sessionItemId: parsed.data.sessionItemId,
          correct: parsed.data.rating !== "again",
          rating: parsed.data.rating,
          responseMs: parsed.data.elapsedMs ?? null,
          xpAwarded,
          bucket: "card",
        });
        sessionSnapshot = {
          sessionItemId: parsed.data.sessionItemId,
          sessionXpEarned: recorded.sessionXpEarned,
          cardsReviewed: recorded.cardsReviewed,
          exercisesAttempted: recorded.exercisesAttempted,
          xpAwarded,
        };
      } catch (sessionError) {
        // The card review is persisted regardless — don't fail the action
        // because we couldn't update the session counters.
        console.warn(
          "recordSessionItemAnswer failed for vocab review",
          sessionError instanceof Error ? sessionError.message : sessionError,
        );
      }
    }
    return { ok: true, review, session: sessionSnapshot };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

const EnsureInputSchema = z.object({
  vocabItemId: z.string().uuid(),
});

export type EnsureVocabCardActionInput = z.infer<typeof EnsureInputSchema>;

export type EnsureVocabCardActionResult =
  | { ok: true; cardId: string; created: boolean }
  | { ok: false; error: string };

// Materialises a `cards` row for a vocab item if the user doesn't have one
// yet — the "start studying this word" path. Safe to call repeatedly.
export async function ensureVocabCardAction(
  input: EnsureVocabCardActionInput,
): Promise<EnsureVocabCardActionResult> {
  const parsed = EnsureInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Invalid request." };
  }

  const user = await requireUser();
  const supabase = await createServerSupabaseClient();
  if (!supabase) {
    return { ok: false, error: "Supabase is not configured for this environment." };
  }

  try {
    const result = await ensureCardForVocabItem(supabase, user.id, parsed.data.vocabItemId);
    return { ok: true, cardId: result.cardId, created: result.created };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

const FetchInputSchema = z
  .object({
    limit: z.number().int().positive().max(100).optional(),
  })
  .optional();

export type FetchDueVocabCardsInput = z.infer<typeof FetchInputSchema>;

export type FetchDueVocabCardsResult =
  | { ok: true; cards: DueVocabCard[] }
  | { ok: false; error: string };

// Convenience wrapper around loadDueVocabCards for client code that wants the
// current due queue without rendering a server component. Mostly useful for
// the lightweight desktop shortcut prototype the UI ticket will plug into.
export async function fetchDueVocabCards(
  input: FetchDueVocabCardsInput = {},
): Promise<FetchDueVocabCardsResult> {
  const parsed = FetchInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Invalid request." };
  }

  const user = await requireUser();
  const supabase = await createServerSupabaseClient();
  if (!supabase) {
    return { ok: false, error: "Supabase is not configured for this environment." };
  }

  try {
    const cards = await loadDueVocabCards(supabase, user.id, {
      limit: parsed.data?.limit,
    });
    return { ok: true, cards };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error.";
}

export type { ReviewRating };
