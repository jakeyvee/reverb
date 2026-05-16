"use server";

import { z } from "zod";
import { ReviewRatingSchema, type ReviewRating } from "@reverb/domain";
import { requireUser } from "@/lib/auth/get-user";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  ensureCardForVocabItem,
  loadDueVocabCards,
  submitVocabReview,
  type DueVocabCard,
  type SubmitVocabReviewOutput,
} from "./reviews";

const SubmitInputSchema = z.object({
  cardId: z.string().uuid(),
  rating: ReviewRatingSchema,
  elapsedMs: z.number().int().nonnegative().optional(),
});

export type SubmitVocabReviewActionInput = z.infer<typeof SubmitInputSchema>;

export type SubmitVocabReviewActionResult =
  | { ok: true; review: SubmitVocabReviewOutput }
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
    return { ok: true, review };
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
