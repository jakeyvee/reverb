// Vocab dedupe key. Mirrors the postgres unique index on
// `vocab_items (household_id, lower(lemma), coalesce(reading, ''))` so the
// in-memory dedupe and the database constraint cannot disagree.

export type VocabKeyInput = {
  lemma: string;
  reading?: string | null;
};

export function normalizeLemma(lemma: string): string {
  return lemma.normalize("NFC").trim();
}

export function normalizeReading(reading: string | null | undefined): string | null {
  if (reading === null || reading === undefined) return null;
  const trimmed = reading.normalize("NFC").trim();
  return trimmed === "" ? null : trimmed;
}

export function vocabDedupeKey({ lemma, reading }: VocabKeyInput): string {
  const lemmaPart = normalizeLemma(lemma).toLowerCase();
  const readingPart = normalizeReading(reading) ?? "";
  return `${lemmaPart}|${readingPart}`;
}
