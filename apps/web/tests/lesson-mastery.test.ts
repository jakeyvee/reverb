import { describe, expect, it } from "vitest";
import {
  FSRS_MASTERY_INTERVAL_DAYS,
  calculateLessonMastery,
  isMasteryEmpty,
  type LessonMasteryInput,
} from "@/lib/lessons/mastery";

// Pure-function coverage for the mastery aggregator. The Supabase loader
// is exercised end-to-end against a real instance; these tests pin the
// rules the dashboard depends on:
//   * vocab mastery uses the FSRS interval threshold,
//   * grammar mastery uses first-try correctness,
//   * mistake mastery uses retired drill state,
//   * missing content types yield percent: null instead of 0% / 100%.

function makeInput(overrides: Partial<LessonMasteryInput> = {}): LessonMasteryInput {
  return {
    vocab: [],
    grammar: [],
    corrections: [],
    ...overrides,
  };
}

describe("calculateLessonMastery — vocab", () => {
  it("counts a card as mastered when scheduled_days >= 21", () => {
    const out = calculateLessonMastery(
      makeInput({
        vocab: [
          { itemId: "v1", scheduledDays: 21 },
          { itemId: "v2", scheduledDays: 90 },
          { itemId: "v3", scheduledDays: 20 },
          { itemId: "v4", scheduledDays: 0 },
        ],
      }),
    );
    expect(out.vocab.total).toBe(4);
    expect(out.vocab.mastered).toBe(2);
    expect(out.vocab.percent).toBe(50);
  });

  it("treats a vocab item with no card as not mastered (still counted)", () => {
    const out = calculateLessonMastery(
      makeInput({
        vocab: [
          { itemId: "v1", scheduledDays: 30 },
          { itemId: "v2", scheduledDays: null },
        ],
      }),
    );
    expect(out.vocab.total).toBe(2);
    expect(out.vocab.mastered).toBe(1);
    expect(out.vocab.percent).toBe(50);
  });

  it("uses 21 days as the canonical threshold", () => {
    expect(FSRS_MASTERY_INTERVAL_DAYS).toBe(21);
  });
});

describe("calculateLessonMastery — grammar", () => {
  it("counts an exercise as mastered only when the first try was correct", () => {
    const out = calculateLessonMastery(
      makeInput({
        grammar: [
          { exerciseId: "g1", firstTryCorrect: true },
          { exerciseId: "g2", firstTryCorrect: false },
          { exerciseId: "g3", firstTryCorrect: null },
        ],
      }),
    );
    expect(out.grammar.total).toBe(3);
    expect(out.grammar.mastered).toBe(1);
    expect(out.grammar.percent).toBe(33);
  });
});

describe("calculateLessonMastery — corrections", () => {
  it("counts a drill as mastered only when its state is 'retired'", () => {
    const out = calculateLessonMastery(
      makeInput({
        corrections: [
          { correctionId: "c1", state: "retired" },
          { correctionId: "c2", state: "learning" },
          { correctionId: "c3", state: "new" },
          { correctionId: "c4", state: null }, // never drilled
        ],
      }),
    );
    expect(out.corrections.total).toBe(4);
    expect(out.corrections.mastered).toBe(1);
    expect(out.corrections.percent).toBe(25);
  });
});

describe("calculateLessonMastery — missing content types", () => {
  it("reports percent: null when a bucket has zero content", () => {
    // A lesson with only vocab extracted (no grammar exercises generated,
    // no teacher corrections found). The dashboard must not render 0% or
    // 100% for the absent buckets — that would mislead about what's
    // possible to master.
    const out = calculateLessonMastery(
      makeInput({
        vocab: [
          { itemId: "v1", scheduledDays: 30 },
          { itemId: "v2", scheduledDays: 5 },
        ],
      }),
    );
    expect(out.vocab.percent).toBe(50);
    expect(out.grammar.total).toBe(0);
    expect(out.grammar.percent).toBeNull();
    expect(out.corrections.total).toBe(0);
    expect(out.corrections.percent).toBeNull();
  });

  it("reports 100% only when every item in a non-empty bucket is mastered", () => {
    const out = calculateLessonMastery(
      makeInput({
        vocab: [{ itemId: "v1", scheduledDays: 100 }],
        grammar: [{ exerciseId: "g1", firstTryCorrect: true }],
        corrections: [{ correctionId: "c1", state: "retired" }],
      }),
    );
    expect(out.vocab.percent).toBe(100);
    expect(out.grammar.percent).toBe(100);
    expect(out.corrections.percent).toBe(100);
  });

  it("reports 0% when every item in a non-empty bucket is unmastered", () => {
    const out = calculateLessonMastery(
      makeInput({
        vocab: [{ itemId: "v1", scheduledDays: 0 }],
        grammar: [{ exerciseId: "g1", firstTryCorrect: false }],
        corrections: [{ correctionId: "c1", state: "learning" }],
      }),
    );
    expect(out.vocab.percent).toBe(0);
    expect(out.grammar.percent).toBe(0);
    expect(out.corrections.percent).toBe(0);
  });

  it("rounds the percentage to the nearest whole percent", () => {
    // 2 out of 3 = 66.66... → renders as 67 in the UI chip.
    const out = calculateLessonMastery(
      makeInput({
        vocab: [
          { itemId: "v1", scheduledDays: 30 },
          { itemId: "v2", scheduledDays: 30 },
          { itemId: "v3", scheduledDays: 5 },
        ],
      }),
    );
    expect(out.vocab.percent).toBe(67);
  });
});

describe("isMasteryEmpty", () => {
  it("returns true only when no content was extracted in any bucket", () => {
    const empty = calculateLessonMastery(makeInput());
    expect(isMasteryEmpty(empty)).toBe(true);
  });

  it("returns false when at least one bucket has content", () => {
    const some = calculateLessonMastery(
      makeInput({ vocab: [{ itemId: "v1", scheduledDays: null }] }),
    );
    expect(isMasteryEmpty(some)).toBe(false);
  });
});
