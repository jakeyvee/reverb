import { describe, expect, it } from "vitest";
import { normalizeLemma, normalizeReading, vocabDedupeKey } from "../src/vocab.js";

describe("normalizeLemma", () => {
  it("trims surrounding whitespace and NFC-normalizes", () => {
    expect(normalizeLemma("  kopi  ")).toBe("kopi");
    // NFC normalization keeps composed characters stable across inputs.
    const decomposed = "é"; // "é" as e + combining acute
    expect(normalizeLemma(decomposed)).toBe("é");
  });

  it("preserves the input casing — only the dedupe key lowercases", () => {
    expect(normalizeLemma("Kopi")).toBe("Kopi");
    expect(normalizeLemma("KOPI")).toBe("KOPI");
  });
});

describe("normalizeReading", () => {
  it("returns null for null, undefined, and whitespace-only readings", () => {
    expect(normalizeReading(null)).toBeNull();
    expect(normalizeReading(undefined)).toBeNull();
    expect(normalizeReading("")).toBeNull();
    expect(normalizeReading("   ")).toBeNull();
  });

  it("trims and NFC-normalizes a non-empty reading", () => {
    expect(normalizeReading("  ko-pi  ")).toBe("ko-pi");
  });
});

describe("vocabDedupeKey", () => {
  it("collapses casing, whitespace, and missing readings to the same key", () => {
    const a = vocabDedupeKey({ lemma: "Kopi" });
    const b = vocabDedupeKey({ lemma: "  KOPI  ", reading: null });
    const c = vocabDedupeKey({ lemma: "kopi", reading: "" });
    const d = vocabDedupeKey({ lemma: "kopi", reading: "   " });
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(d).toBe(a);
  });

  it("treats words with the same lemma but different readings as distinct", () => {
    const noReading = vocabDedupeKey({ lemma: "kopi" });
    const withReading = vocabDedupeKey({ lemma: "kopi", reading: "ko-pi" });
    expect(withReading).not.toBe(noReading);
  });

  it("mirrors the unique index — lower(lemma) + coalesce(reading, '')", () => {
    expect(vocabDedupeKey({ lemma: "Kopi", reading: "ko-pi" })).toBe("kopi|ko-pi");
    expect(vocabDedupeKey({ lemma: "kopi" })).toBe("kopi|");
  });
});
