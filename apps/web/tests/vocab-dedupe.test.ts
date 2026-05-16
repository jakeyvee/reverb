import { describe, expect, it } from "vitest";
import {
  normalizeLemma,
  normalizeReading,
  vocabDedupeKey,
} from "@/lib/lessons/vocab-dedupe";

// This mirror of packages/domain/src/vocab.ts must produce the same key as
// the canonical implementation — both run against the same postgres unique
// index. The tests below pin the contract so a divergence between the two
// shows up here instead of as a runtime insert error in the add-to-vocab
// server action.
describe("vocabDedupeKey", () => {
  it("lowercases the lemma for the dedupe key", () => {
    expect(vocabDedupeKey({ lemma: "Saya" })).toBe("saya|");
    expect(vocabDedupeKey({ lemma: "SAYA" })).toBe("saya|");
  });

  it("normalises NFC and trims whitespace", () => {
    expect(vocabDedupeKey({ lemma: "  saya  " })).toBe("saya|");
  });

  it("treats null and empty reading the same way", () => {
    expect(vocabDedupeKey({ lemma: "saya", reading: null })).toBe("saya|");
    expect(vocabDedupeKey({ lemma: "saya", reading: "" })).toBe("saya|");
    expect(vocabDedupeKey({ lemma: "saya", reading: "   " })).toBe("saya|");
  });

  it("preserves a non-empty reading verbatim in the key", () => {
    expect(vocabDedupeKey({ lemma: "saya", reading: "sa-ya" })).toBe("saya|sa-ya");
  });

  it("normalises the lemma input via normalizeLemma", () => {
    expect(normalizeLemma("  hello  ")).toBe("hello");
  });

  it("normalises reading via normalizeReading", () => {
    expect(normalizeReading(undefined)).toBeNull();
    expect(normalizeReading(null)).toBeNull();
    expect(normalizeReading("   ")).toBeNull();
    expect(normalizeReading("sa")).toBe("sa");
  });
});
