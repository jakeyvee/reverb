// Mirror of the household-shared vocab dedupe key from packages/domain/src/
// vocab.ts. Re-implemented locally because the Next.js flight loader can't
// follow the `.js` re-exports inside @reverb/domain when a server action is
// the entry point. Identical normalisation, identical key shape — the
// postgres unique index on
//   vocab_items (household_id, lower(lemma), coalesce(reading, ''))
// is the source of truth either way.
//
// Tests for the canonical form live in packages/domain. The duplication here
// is small enough that re-validating end-to-end via /lessons feels safer
// than chasing a build-graph workaround.

export function normalizeLemma(lemma: string): string {
  return lemma.normalize("NFC").trim();
}

export function normalizeReading(reading: string | null | undefined): string | null {
  if (reading === null || reading === undefined) return null;
  const trimmed = reading.normalize("NFC").trim();
  return trimmed === "" ? null : trimmed;
}

export function vocabDedupeKey(input: { lemma: string; reading?: string | null }): string {
  const lemmaPart = normalizeLemma(input.lemma).toLowerCase();
  const readingPart = normalizeReading(input.reading ?? null) ?? "";
  return `${lemmaPart}|${readingPart}`;
}
