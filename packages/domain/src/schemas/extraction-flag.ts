import { z } from "zod";

// Mirrors `public.extraction_flag_target_kind` in the DB. The four entries map
// 1:1 to the rows the extracting step writes (vocab/grammar/dialogue/
// corrections), so the action that records a flag can carry the same labels
// the LLM emitted without translation.
export const EXTRACTION_FLAG_TARGET_KINDS = ["vocab", "grammar", "dialogue", "correction"] as const;

export type ExtractionFlagTargetKind = (typeof EXTRACTION_FLAG_TARGET_KINDS)[number];

export const ExtractionFlagTargetKindSchema = z.enum(EXTRACTION_FLAG_TARGET_KINDS);

// Mirrors `public.extraction_flag_reason`. The set is deliberately small —
// open-ended notes live on the free-text `notes` column. The fixed reasons
// power the future prompt-eval breakdown without having to NLP user notes.
export const EXTRACTION_FLAG_REASONS = [
  "wrong_translation",
  "not_a_word",
  "wrong_split",
  "duplicate",
  "low_value",
  "other",
] as const;

export type ExtractionFlagReason = (typeof EXTRACTION_FLAG_REASONS)[number];

export const ExtractionFlagReasonSchema = z.enum(EXTRACTION_FLAG_REASONS);

const EXTRACTION_FLAG_REASON_LABELS: Record<ExtractionFlagReason, string> = {
  wrong_translation: "Wrong translation",
  not_a_word: "Not a real word",
  wrong_split: "Wrong word split",
  duplicate: "Duplicate of another item",
  low_value: "Not useful to study",
  other: "Other",
};

export function extractionFlagReasonLabel(reason: ExtractionFlagReason): string {
  return EXTRACTION_FLAG_REASON_LABELS[reason];
}

export const ExtractionFlagInputSchema = z.object({
  targetKind: ExtractionFlagTargetKindSchema,
  targetId: z.string().uuid(),
  reason: ExtractionFlagReasonSchema,
  notes: z.string().trim().max(2000).optional(),
});

export type ExtractionFlagInput = z.infer<typeof ExtractionFlagInputSchema>;
