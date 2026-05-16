import { describe, expect, it } from "vitest";
import { tokenizeTranscriptSegment } from "@/lib/lessons/transcript-tokens";

describe("tokenizeTranscriptSegment", () => {
  it("returns an empty array for empty input", () => {
    expect(tokenizeTranscriptSegment("")).toEqual([]);
  });

  it("splits a simple sentence into words plus spaces and punctuation", () => {
    const tokens = tokenizeTranscriptSegment("Halo, apa kabar?");
    expect(tokens.map((t) => t.raw).join("")).toBe("Halo, apa kabar?");
    const words = tokens.filter((t) => t.kind === "word").map((t) => t.raw);
    expect(words).toEqual(["Halo", "apa", "kabar"]);
  });

  it("lowercases the clean form for words but keeps `raw` verbatim", () => {
    const tokens = tokenizeTranscriptSegment("Saya Suka");
    const words = tokens.filter((t) => t.kind === "word");
    expect(words.map((t) => t.raw)).toEqual(["Saya", "Suka"]);
    expect(words.map((t) => t.word)).toEqual(["saya", "suka"]);
  });

  it("preserves Bahasa hyphenated reduplication as separate words", () => {
    // Reduplication like "buku-buku" reads as two distinct lookups, so the
    // hyphen acts as a token boundary rather than a within-word character.
    const tokens = tokenizeTranscriptSegment("buku-buku");
    const words = tokens.filter((t) => t.kind === "word").map((t) => t.raw);
    expect(words).toEqual(["buku", "buku"]);
    // The hyphen survives as an "other" token so the segment still renders
    // exactly as it was stored.
    const other = tokens.filter((t) => t.kind === "other").map((t) => t.raw);
    expect(other).toEqual(["-"]);
  });

  it("keeps apostrophes inside words (English contractions)", () => {
    const tokens = tokenizeTranscriptSegment("can't");
    const words = tokens.filter((t) => t.kind === "word").map((t) => t.raw);
    expect(words).toEqual(["can't"]);
  });

  it("reproduces the source string verbatim when joined back", () => {
    const inputs = [
      "Hello world",
      "  leading and trailing  ",
      "Multi\nline\ntext",
      "Numbers 123 mixed",
      "Mixed-case AND symbols!",
    ];
    for (const input of inputs) {
      const tokens = tokenizeTranscriptSegment(input);
      expect(tokens.map((t) => t.raw).join("")).toBe(input);
    }
  });
});
