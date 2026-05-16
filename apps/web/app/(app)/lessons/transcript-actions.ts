"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createServiceRoleClient } from "@reverb/db/server";
import type { Json } from "@reverb/db/types";
import { glossWord, translateSentence } from "@/lib/lessons/translation";
import {
  normalizeLemma,
  normalizeReading,
  vocabDedupeKey,
} from "@/lib/lessons/vocab-dedupe";
import { requireUser } from "@/lib/auth/get-user";
import { getProfile } from "@/lib/auth/get-profile";

// Default translation locale for the Lesson Detail toggle. Hard-coded for the
// MVP: every household is currently English-native and learning Bahasa, so
// "translation" always means "render the Bahasa segment in English". If we
// later need per-user gloss-language preference we'll thread it through here.
const DEFAULT_TRANSLATION_LOCALE = "en";

// ---------------------------------------------------------------------------
// Translate a single transcript segment (server action)
// ---------------------------------------------------------------------------

const TranslateSegmentInputSchema = z.object({
  segmentId: z.string().uuid(),
});

export type TranslateSegmentInput = z.infer<typeof TranslateSegmentInputSchema>;
export type TranslateSegmentResult =
  | {
      ok: true;
      segmentId: string;
      translation: string;
      translationLanguage: string;
      cached: boolean;
    }
  | { ok: false; error: string };

// Translates one segment's text from its source language to English (or the
// household's gloss locale). Idempotent: a cached row is returned without a
// model call. New translations are written back to the row so a partner
// toggling the same segment minutes later sees the same text.
export async function translateTranscriptSegment(
  input: TranslateSegmentInput,
): Promise<TranslateSegmentResult> {
  const parsed = TranslateSegmentInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const user = await requireUser();
  const profile = await getProfile(user.id);
  if (!profile) return { ok: false, error: "Could not resolve your household." };

  const supabase = createServiceRoleClient();

  // Load the segment and confirm the household owns the parent lesson.
  // Service role bypasses RLS, so we re-check household_id ourselves rather
  // than trust the segment id off the wire.
  const { data: segment, error: segmentError } = await supabase
    .from("transcript_segments")
    .select(
      "id, text, language, translation, translation_language, lesson_id, lessons!inner(household_id, source_language, target_language)",
    )
    .eq("id", parsed.data.segmentId)
    .maybeSingle();
  if (segmentError || !segment) {
    return { ok: false, error: "Segment not found." };
  }
  const lesson = Array.isArray(segment.lessons) ? segment.lessons[0] : segment.lessons;
  if (!lesson || lesson.household_id !== profile.householdId) {
    return { ok: false, error: "Segment not found." };
  }

  // Cache hit — already translated to the same locale. Skip the model call.
  if (
    segment.translation &&
    (segment.translation_language ?? DEFAULT_TRANSLATION_LOCALE) === DEFAULT_TRANSLATION_LOCALE
  ) {
    return {
      ok: true,
      segmentId: segment.id,
      translation: segment.translation,
      translationLanguage: segment.translation_language ?? DEFAULT_TRANSLATION_LOCALE,
      cached: true,
    };
  }

  // English-only / code-switched segments where the segment language already
  // matches the target locale: skip the API call and store the source text
  // verbatim so the toggle has a stable response for the segment.
  const sourceLanguage = segment.language ?? lesson.source_language ?? lesson.target_language ?? null;
  const text = segment.text;
  const trimmedText = text.trim();
  if (
    sourceLanguage &&
    sourceLanguage.toLowerCase().startsWith(DEFAULT_TRANSLATION_LOCALE.toLowerCase())
  ) {
    const persisted = await persistTranslation(supabase, segment.id, trimmedText, DEFAULT_TRANSLATION_LOCALE);
    if (!persisted.ok) return persisted;
    revalidatePath(`/lessons/${segment.lesson_id}`);
    return {
      ok: true,
      segmentId: segment.id,
      translation: trimmedText,
      translationLanguage: DEFAULT_TRANSLATION_LOCALE,
      cached: false,
    };
  }

  let translation: string;
  try {
    const result = await translateSentence({
      text,
      sourceLanguage,
      targetLanguage: DEFAULT_TRANSLATION_LOCALE,
    });
    translation = result.translation;
  } catch (err) {
    console.error("[translateTranscriptSegment] anthropic failed", err);
    return { ok: false, error: "Translation failed. Try again in a moment." };
  }

  const persisted = await persistTranslation(supabase, segment.id, translation, DEFAULT_TRANSLATION_LOCALE);
  if (!persisted.ok) return persisted;

  revalidatePath(`/lessons/${segment.lesson_id}`);
  return {
    ok: true,
    segmentId: segment.id,
    translation,
    translationLanguage: DEFAULT_TRANSLATION_LOCALE,
    cached: false,
  };
}

async function persistTranslation(
  supabase: ReturnType<typeof createServiceRoleClient>,
  segmentId: string,
  translation: string,
  translationLanguage: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase
    .from("transcript_segments")
    .update({
      translation,
      translation_language: translationLanguage,
      translated_at: new Date().toISOString(),
    })
    .eq("id", segmentId);
  if (error) {
    console.error("[translateTranscriptSegment] persist failed", error);
    return { ok: false, error: "Could not save translation." };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Gloss a single clicked word (server action)
// ---------------------------------------------------------------------------

const GlossWordInputSchema = z.object({
  segmentId: z.string().uuid(),
  word: z.string().trim().min(1).max(64),
});

export type GlossWordActionInput = z.infer<typeof GlossWordInputSchema>;
export type GlossWordActionResult =
  | {
      ok: true;
      word: string;
      gloss: string;
      glossLanguage: string;
      sourceLanguage: string | null;
      sentence: string;
    }
  | { ok: false; error: string };

// Returns an ephemeral one-line gloss for a clicked word. We do NOT persist
// the gloss yet — the popover lives only for the click. Adding the word to
// vocab (below) writes a real `vocab_items` row with this gloss baked in.
export async function glossTranscriptWord(input: GlossWordActionInput): Promise<GlossWordActionResult> {
  const parsed = GlossWordInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const user = await requireUser();
  const profile = await getProfile(user.id);
  if (!profile) return { ok: false, error: "Could not resolve your household." };

  const supabase = createServiceRoleClient();

  const { data: segment, error: segmentError } = await supabase
    .from("transcript_segments")
    .select("id, text, language, lessons!inner(household_id, source_language, target_language)")
    .eq("id", parsed.data.segmentId)
    .maybeSingle();
  if (segmentError || !segment) {
    return { ok: false, error: "Segment not found." };
  }
  const lesson = Array.isArray(segment.lessons) ? segment.lessons[0] : segment.lessons;
  if (!lesson || lesson.household_id !== profile.householdId) {
    return { ok: false, error: "Segment not found." };
  }

  const sourceLanguage = segment.language ?? lesson.source_language ?? lesson.target_language ?? null;
  try {
    const result = await glossWord({
      word: parsed.data.word,
      sentence: segment.text,
      sourceLanguage,
      glossLanguage: DEFAULT_TRANSLATION_LOCALE,
    });
    return {
      ok: true,
      word: parsed.data.word,
      gloss: result.gloss,
      glossLanguage: DEFAULT_TRANSLATION_LOCALE,
      sourceLanguage,
      sentence: segment.text,
    };
  } catch (err) {
    console.error("[glossTranscriptWord] anthropic failed", err);
    return { ok: false, error: "Couldn't look that word up. Try again." };
  }
}

// ---------------------------------------------------------------------------
// Add a clicked word to the household's vocab + the user's card stack
// ---------------------------------------------------------------------------

const AddTranscriptWordToVocabInputSchema = z.object({
  segmentId: z.string().uuid(),
  word: z.string().trim().min(1).max(64),
  // Caller passes the gloss it just rendered in the popover so the persisted
  // row matches what the user saw. We re-query the gloss server-side if the
  // client did not supply one.
  gloss: z.string().trim().min(1).max(512).optional(),
});

export type AddTranscriptWordToVocabInput = z.infer<typeof AddTranscriptWordToVocabInputSchema>;
export type AddTranscriptWordToVocabResult =
  | {
      ok: true;
      vocabItemId: string;
      cardId: string;
      lemma: string;
      gloss: string;
      reused: boolean;
    }
  | { ok: false; error: string };

// Mirror of the extraction-stage vocab path (apps/jobs/.../steps.ts:
// reconcileVocab + persistCards). Same dedupe key, same per-user card upsert
// with `(user_id, vocab_item_id)` ignoreDuplicates so re-clicking the same
// word is a no-op rather than a duplicate row.
export async function addTranscriptWordToVocab(
  input: AddTranscriptWordToVocabInput,
): Promise<AddTranscriptWordToVocabResult> {
  const parsed = AddTranscriptWordToVocabInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const user = await requireUser();
  const profile = await getProfile(user.id);
  if (!profile) return { ok: false, error: "Could not resolve your household." };

  const supabase = createServiceRoleClient();

  // Load segment + parent lesson + source language for the eventual gloss
  // call. Same household-scope check as the other transcript actions.
  const { data: segment, error: segmentError } = await supabase
    .from("transcript_segments")
    .select(
      "id, text, language, lesson_id, lessons!inner(id, household_id, source_language, target_language)",
    )
    .eq("id", parsed.data.segmentId)
    .maybeSingle();
  if (segmentError || !segment) {
    return { ok: false, error: "Segment not found." };
  }
  const lesson = Array.isArray(segment.lessons) ? segment.lessons[0] : segment.lessons;
  if (!lesson || lesson.household_id !== profile.householdId) {
    return { ok: false, error: "Segment not found." };
  }

  const sourceLanguage = segment.language ?? lesson.source_language ?? lesson.target_language ?? null;

  // Reuse the popover gloss when the client passed one; otherwise generate
  // one now. We never save a vocab row without a translation — the SRS
  // queue is unreadable if cards have no back.
  let gloss = parsed.data.gloss?.trim() ?? "";
  if (gloss.length === 0) {
    try {
      const result = await glossWord({
        word: parsed.data.word,
        sentence: segment.text,
        sourceLanguage,
        glossLanguage: DEFAULT_TRANSLATION_LOCALE,
      });
      gloss = result.gloss;
    } catch (err) {
      console.error("[addTranscriptWordToVocab] gloss failed", err);
      return { ok: false, error: "Couldn't look that word up. Try again." };
    }
  }

  const lemma = normalizeLemma(parsed.data.word);
  if (lemma.length === 0) {
    return { ok: false, error: "Word is empty after normalisation." };
  }
  const reading = normalizeReading(null);
  const dedupeKey = vocabDedupeKey({ lemma, reading });

  // ---- Dedupe step. Mirror apps/jobs/.../steps.ts:loadHouseholdVocabIndex.
  // The unique index on (household_id, lower(lemma), coalesce(reading,''))
  // is the source of truth; this query just lets us reuse an existing row
  // (so the card chain to it stays stable) when the lemma is already known.
  const { data: existingRows, error: existingError } = await supabase
    .from("vocab_items")
    .select("id, lemma, reading")
    .eq("household_id", profile.householdId)
    .ilike("lemma", lemma.replace(/[\\%_]/g, "\\$&"));
  if (existingError) {
    console.error("[addTranscriptWordToVocab] lookup failed", existingError);
    return { ok: false, error: "Could not check existing vocab." };
  }

  type ExistingRow = { id: string; lemma: string; reading: string | null };
  const match = (existingRows ?? []).find(
    (row) => vocabDedupeKey({ lemma: row.lemma, reading: row.reading }) === dedupeKey,
  ) as ExistingRow | undefined;

  let vocabItemId: string;
  let reused = false;
  if (match) {
    vocabItemId = match.id;
    reused = true;
  } else {
    const metadata: Record<string, unknown> = {
      source: "transcript_click",
      source_lesson_id: lesson.id,
      source_segment_id: segment.id,
      source_transcript_id: lesson.id,
      added_by_user_id: user.id,
      gloss_language: DEFAULT_TRANSLATION_LOCALE,
    };
    const { data: inserted, error: insertError } = await supabase
      .from("vocab_items")
      .insert({
        household_id: profile.householdId,
        lesson_id: lesson.id,
        lemma,
        reading,
        translation: gloss,
        part_of_speech: null,
        example_sentence: segment.text,
        example_translation: null,
        audio_storage_bucket: null,
        audio_storage_path: null,
        difficulty: null,
        metadata: metadata as unknown as Json,
      })
      .select("id")
      .single();
    if (insertError || !inserted) {
      // The unique index can race with another concurrent click in the same
      // household. Re-read on conflict so we still return the canonical id.
      if (insertError && insertError.code === "23505") {
        const { data: raced } = await supabase
          .from("vocab_items")
          .select("id, lemma, reading")
          .eq("household_id", profile.householdId)
          .ilike("lemma", lemma.replace(/[\\%_]/g, "\\$&"));
        const rerace = (raced ?? []).find(
          (row) => vocabDedupeKey({ lemma: row.lemma, reading: row.reading }) === dedupeKey,
        );
        if (rerace) {
          vocabItemId = rerace.id;
          reused = true;
        } else {
          console.error("[addTranscriptWordToVocab] insert race unresolved", insertError);
          return { ok: false, error: "Could not save this word." };
        }
      } else {
        console.error("[addTranscriptWordToVocab] insert failed", insertError);
        return { ok: false, error: "Could not save this word." };
      }
    } else {
      vocabItemId = inserted.id;
    }
  }

  // Per-user card. `ignoreDuplicates: true` is the same idempotency posture
  // as the extraction step's persistCards — re-clicking the same word does
  // NOT reset the FSRS state on an existing card.
  const cardMetadata: Record<string, unknown> = {
    source: "transcript_click",
    source_lesson_id: lesson.id,
    source_segment_id: segment.id,
    source_transcript_id: lesson.id,
    example_sentence: segment.text,
    example_translation: null,
    added_by_user_id: user.id,
    gloss_language: DEFAULT_TRANSLATION_LOCALE,
  };
  const { error: cardUpsertError } = await supabase
    .from("cards")
    .upsert(
      [
        {
          user_id: user.id,
          vocab_item_id: vocabItemId,
          metadata: cardMetadata as unknown as Json,
        },
      ],
      { onConflict: "user_id,vocab_item_id", ignoreDuplicates: true },
    );
  if (cardUpsertError) {
    console.error("[addTranscriptWordToVocab] card upsert failed", cardUpsertError);
    return { ok: false, error: "Could not link this word to your deck." };
  }

  // Re-read the card id so the caller can display a "Go to card" link in the
  // popover. We always look it up rather than rely on the upsert's `.select`,
  // because ignoreDuplicates=true returns no row when the conflict fires.
  const { data: card, error: cardLookupError } = await supabase
    .from("cards")
    .select("id")
    .eq("user_id", user.id)
    .eq("vocab_item_id", vocabItemId)
    .maybeSingle();
  if (cardLookupError || !card) {
    console.error("[addTranscriptWordToVocab] card lookup failed", cardLookupError);
    return { ok: false, error: "Could not link this word to your deck." };
  }

  revalidatePath(`/lessons/${segment.lesson_id}`);
  revalidatePath("/session");

  return {
    ok: true,
    vocabItemId,
    cardId: card.id,
    lemma,
    gloss,
    reused,
  };
}
