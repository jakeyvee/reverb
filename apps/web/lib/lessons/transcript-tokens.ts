// Tokenises a transcript segment so the Lesson Detail view can render each
// word as its own clickable element while preserving whitespace and
// punctuation between them. The output keeps the original ordering and is a
// 1:1 representation of the input string (concatenating `token.raw` for every
// token reproduces the source verbatim).
//
// "Word" here means a contiguous run of letters / numbers / common diacritics
// — the regex below uses the Unicode Letter category so Bahasa words (which
// frequently include hyphens for reduplication, e.g. "buku-buku") are split
// into the smaller halves a learner usually wants to gloss. Punctuation /
// whitespace is preserved verbatim and tagged with `kind: "other"` so the
// renderer can skip click-handling on it.

export type TranscriptToken = {
  // The exact substring from the source text. Joining every token's raw value
  // back-to-back reproduces the original string.
  raw: string;
  // For words: the lower-cased clean form, suitable for vocab dedupe and gloss
  // lookup. For "other" tokens this is the empty string.
  word: string;
  kind: "word" | "other";
};

const WORD_REGEX = /(\p{L}[\p{L}\p{M}\p{Nd}'’]*)/gu;

export function tokenizeTranscriptSegment(text: string): TranscriptToken[] {
  if (text.length === 0) return [];
  const tokens: TranscriptToken[] = [];
  let cursor = 0;
  for (const match of text.matchAll(WORD_REGEX)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (start > cursor) {
      tokens.push({ raw: text.slice(cursor, start), word: "", kind: "other" });
    }
    tokens.push({
      raw: match[0],
      word: match[0].toLocaleLowerCase(),
      kind: "word",
    });
    cursor = end;
  }
  if (cursor < text.length) {
    tokens.push({ raw: text.slice(cursor), word: "", kind: "other" });
  }
  return tokens;
}
