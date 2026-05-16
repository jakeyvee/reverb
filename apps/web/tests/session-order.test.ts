import { describe, expect, it } from "vitest";
import { orderDailySession } from "@/lib/session/order";
import type { CorrectionDrillView, VocabPreview } from "@/lib/session/correction-drills";

function buildDrill(id: string, dueAt: string): CorrectionDrillView {
  return {
    drillId: id,
    state: "learning",
    dueAt,
    attempts: 1,
    passes: 0,
    fails: 1,
    consecutivePasses: 0,
    xpEarned: 0,
    correction: {
      id: `correction-${id}`,
      kind: "grammar",
      sourceText: "saya mau kopi",
      correctedText: "Saya mau kopi.",
      explanation: null,
      confidence: 0.9,
      lessonId: "lesson-1",
    },
    confidenceTier: "eligible",
  };
}

function buildVocab(id: string): VocabPreview {
  return {
    vocabItemId: id,
    cardId: null,
    lemma: `lemma-${id}`,
    translation: `translation-${id}`,
    dueAt: null,
  };
}

describe("orderDailySession", () => {
  it("places correction drills ahead of fresh vocab", () => {
    const queue = orderDailySession({
      corrections: [buildDrill("a", "2026-05-15T09:00:00Z")],
      freshVocab: [buildVocab("v1"), buildVocab("v2")],
    });
    expect(queue.map((entry) => entry.kind)).toEqual(["correction", "vocab", "vocab"]);
    expect(queue[0]).toMatchObject({ kind: "correction" });
  });

  it("returns vocab-only queue when there are no correction drills", () => {
    const queue = orderDailySession({
      corrections: [],
      freshVocab: [buildVocab("v1")],
    });
    expect(queue).toHaveLength(1);
    expect(queue[0]?.kind).toBe("vocab");
  });

  it("preserves the caller's correction ordering (the loader is responsible for due_at sort)", () => {
    const queue = orderDailySession({
      corrections: [
        buildDrill("first", "2026-05-15T08:00:00Z"),
        buildDrill("second", "2026-05-15T09:00:00Z"),
      ],
      freshVocab: [],
    });
    expect(queue.map((entry) => (entry.kind === "correction" ? entry.drill.drillId : null))).toEqual([
      "first",
      "second",
    ]);
  });
});
