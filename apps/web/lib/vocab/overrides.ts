"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  ExtractionFlagInputSchema,
  type ExtractionFlagInput,
} from "@reverb/domain/schemas/extraction-flag";
import type { TablesInsert } from "@reverb/db/types";
import { requireUser } from "@/lib/auth/get-user";
import { getProfile } from "@/lib/auth/get-profile";
import { createServerSupabaseClient } from "@/lib/supabase/server";

// Server actions for VOL-136's lightweight overrides:
//
//   - markVocabKnown: per-user "I already know this word". Inserts a
//     `user_known_words` row and removes the user's card for that vocab so
//     the review queue stops showing it. The partner's card is untouched —
//     vocab is household-shared but the deck is per-user.
//
//   - flagExtractedItem: records the user's "this extraction is wrong"
//     feedback as an `extraction_flags` row, snapshotting the LLM context
//     (run id, model, prompt_version) so a future prompt eval can replay
//     failures without re-deriving them. Flags are advisory: they do NOT
//     remove the item from anyone's deck. If the user also wants the item
//     gone, they can mark it known.

const MarkKnownInputSchema = z.object({
  vocabItemId: z.string().uuid(),
});

export type MarkVocabKnownInput = z.infer<typeof MarkKnownInputSchema>;
export type MarkVocabKnownResult =
  | { ok: true; cardRemoved: boolean }
  | { ok: false; error: string };

export async function markVocabKnownAction(
  input: MarkVocabKnownInput,
): Promise<MarkVocabKnownResult> {
  const parsed = MarkKnownInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const user = await requireUser();
  const supabase = await createServerSupabaseClient();
  if (!supabase) return { ok: false, error: "Supabase is not configured for this environment." };

  // Insert with `upsert + ignoreDuplicates` so double-clicks coalesce — the
  // (user_id, vocab_item_id) primary key handles dedupe at the DB level.
  // RLS already scopes this to the caller's own rows.
  const knownRow: TablesInsert<"user_known_words"> = {
    user_id: user.id,
    vocab_item_id: parsed.data.vocabItemId,
    source: "self_report",
  };
  const { error: insertError } = await supabase
    .from("user_known_words")
    .upsert(knownRow, { onConflict: "user_id,vocab_item_id", ignoreDuplicates: true });
  if (insertError) {
    return { ok: false, error: "Could not record the known-word mark." };
  }

  // Remove the user's card for this vocab so it leaves the review queue
  // immediately. The select-then-delete pattern is the easiest way to know
  // whether a row was actually removed (PostgREST's `.delete()` doesn't
  // return a count when you pass `.eq`, just the rows you `.select()`).
  // RLS makes this self-scoped; the explicit user_id clause keeps the
  // intent obvious and uses the (user_id, vocab_item_id) composite index.
  const { data: removed, error: deleteError } = await supabase
    .from("cards")
    .delete()
    .eq("user_id", user.id)
    .eq("vocab_item_id", parsed.data.vocabItemId)
    .select("id");
  if (deleteError) {
    return { ok: false, error: "Could not remove the card." };
  }

  revalidatePath("/session");
  revalidatePath("/");

  return { ok: true, cardRemoved: (removed?.length ?? 0) > 0 };
}

const FlagInputSchema = ExtractionFlagInputSchema;

export type FlagExtractedItemInput = ExtractionFlagInput;
export type FlagExtractedItemResult = { ok: true; flagId: string } | { ok: false; error: string };

// Map each target_kind to (a) the table that owns the row and (b) the
// fields we read to snapshot the extraction context. The shape mirrors
// `extraction_metadata` written by the extracting step, which carries
// `model` and `prompt_version` alongside the source segments.
const TARGET_LOOKUP = {
  vocab: { table: "vocab_items" as const, householdField: "household_id" as const },
  grammar: { table: "grammar_patterns" as const, householdField: "household_id" as const },
  dialogue: { table: "dialogue_clips" as const, householdField: "household_id" as const },
  correction: {
    table: "teacher_corrections" as const,
    householdField: "household_id" as const,
  },
} satisfies Record<ExtractionFlagInput["targetKind"], { table: string; householdField: string }>;

export async function flagExtractedItemAction(
  input: FlagExtractedItemInput,
): Promise<FlagExtractedItemResult> {
  const parsed = FlagInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const user = await requireUser();
  const profile = await getProfile(user.id);
  if (!profile) return { ok: false, error: "Could not resolve your household." };

  const supabase = await createServerSupabaseClient();
  if (!supabase) return { ok: false, error: "Supabase is not configured for this environment." };

  const lookup = TARGET_LOOKUP[parsed.data.targetKind];

  // Read the target row to (a) confirm it exists in the caller's household
  // (RLS already filters, but a missing row otherwise yields a confusing
  // "violates RLS" insert error) and (b) snapshot the extraction context
  // off its metadata. We pass a lenient `select("*")` because the metadata
  // shape differs between the four tables.
  const { data: target, error: targetError } = await supabase
    .from(lookup.table)
    .select("id, lesson_id, household_id, metadata")
    .eq("id", parsed.data.targetId)
    .maybeSingle();
  if (targetError || !target) {
    return { ok: false, error: "Could not find the item to flag." };
  }
  if (target.household_id !== profile.householdId) {
    return { ok: false, error: "Item is not in your household." };
  }
  if (!target.lesson_id) {
    return { ok: false, error: "This item is not attached to a lesson." };
  }

  const meta = (target.metadata ?? {}) as Record<string, unknown>;
  const model = typeof meta.model === "string" ? meta.model : null;
  const promptVersion = typeof meta.prompt_version === "string" ? meta.prompt_version : null;

  // Resolve the matching extraction_run for this (lesson, kind, model,
  // prompt_version). The dedupe (target_kind, target_id, flagged_by) unique
  // constraint coalesces double-clicks; the run lookup is best-effort because
  // historical rows may pre-date a prompt_version label.
  const extractionRunKind =
    parsed.data.targetKind === "correction" ? "corrections" : parsed.data.targetKind;
  let extractionRunId: string | null = null;
  if (promptVersion) {
    const { data: run } = await supabase
      .from("extraction_runs")
      .select("id")
      .eq("lesson_id", target.lesson_id)
      .eq("kind", extractionRunKind)
      .eq("prompt_version", promptVersion)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    extractionRunId = run?.id ?? null;
  }

  const flagRow: TablesInsert<"extraction_flags"> = {
    household_id: profile.householdId,
    lesson_id: target.lesson_id,
    target_kind: parsed.data.targetKind,
    target_id: parsed.data.targetId,
    reason: parsed.data.reason,
    notes: parsed.data.notes ?? null,
    flagged_by: user.id,
    extraction_run_id: extractionRunId,
    model,
    prompt_version: promptVersion,
  };
  const { data: inserted, error: insertError } = await supabase
    .from("extraction_flags")
    .upsert(flagRow, {
      onConflict: "target_kind,target_id,flagged_by",
      ignoreDuplicates: false,
    })
    .select("id")
    .maybeSingle();
  if (insertError) {
    return { ok: false, error: "Could not record the flag." };
  }
  if (!inserted) {
    // Race-safe re-read for the upsert-ignoreDuplicates path. Shouldn't
    // happen since we set ignoreDuplicates: false above, but defensive.
    const { data: existing } = await supabase
      .from("extraction_flags")
      .select("id")
      .eq("target_kind", parsed.data.targetKind)
      .eq("target_id", parsed.data.targetId)
      .eq("flagged_by", user.id)
      .maybeSingle();
    if (existing) return { ok: true, flagId: existing.id };
    return { ok: false, error: "Could not record the flag." };
  }

  revalidatePath("/session");
  revalidatePath(`/lessons/${target.lesson_id}`);

  return { ok: true, flagId: inserted.id };
}
