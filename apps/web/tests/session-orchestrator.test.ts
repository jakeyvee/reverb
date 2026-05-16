import { describe, expect, it } from "vitest";
import { assembleSessionQueue, xpForVocabRating } from "@/lib/session/orchestrator";

// Pure-function coverage for the orchestrator. The end-to-end DB flow is
// exercised in integration runs against a Supabase instance; these tests
// pin the rules that decide the visible queue:
//   1. mistake drills always lead vocab cards, vocab cards lead shadowing,
//   2. the caller's ordering inside each kind is preserved (loaders are
//      responsible for due_at sorting),
//   3. XP awards per vocab rating match the orchestrator's published map.

describe("assembleSessionQueue", () => {
  it("places mistake drills ahead of vocab cards", () => {
    const queue = assembleSessionQueue({
      corrections: [{ drillId: "drill-a" }],
      vocabCards: [{ cardId: "card-1" }, { cardId: "card-2" }],
    });
    expect(queue.map((entry) => entry.kind)).toEqual(["mistake_drill", "card", "card"]);
  });

  it("returns vocab-only queue when there are no mistake drills", () => {
    const queue = assembleSessionQueue({
      corrections: [],
      vocabCards: [{ cardId: "card-1" }],
    });
    expect(queue).toHaveLength(1);
    expect(queue[0]).toEqual({ kind: "card", cardId: "card-1" });
  });

  it("returns drills-only queue when there are no vocab cards", () => {
    const queue = assembleSessionQueue({
      corrections: [{ drillId: "drill-a" }, { drillId: "drill-b" }],
      vocabCards: [],
    });
    expect(
      queue.map((entry) => (entry.kind === "mistake_drill" ? entry.correctionDrillId : null)),
    ).toEqual(["drill-a", "drill-b"]);
  });

  it("preserves caller ordering inside each kind", () => {
    const queue = assembleSessionQueue({
      corrections: [{ drillId: "first" }, { drillId: "second" }],
      vocabCards: [{ cardId: "vocab-first" }, { cardId: "vocab-second" }],
    });
    expect(queue).toEqual([
      { kind: "mistake_drill", correctionDrillId: "first" },
      { kind: "mistake_drill", correctionDrillId: "second" },
      { kind: "card", cardId: "vocab-first" },
      { kind: "card", cardId: "vocab-second" },
    ]);
  });

  it("appends shadowing items after drills and vocab", () => {
    const queue = assembleSessionQueue({
      corrections: [{ drillId: "drill-a" }],
      vocabCards: [{ cardId: "card-1" }],
      shadowingClips: [{ clipId: "clip-a" }, { clipId: "clip-b" }],
    });
    expect(queue).toEqual([
      { kind: "mistake_drill", correctionDrillId: "drill-a" },
      { kind: "card", cardId: "card-1" },
      { kind: "shadowing", dialogueClipId: "clip-a" },
      { kind: "shadowing", dialogueClipId: "clip-b" },
    ]);
  });

  it("returns shadowing-only queue when nothing else is due", () => {
    const queue = assembleSessionQueue({
      corrections: [],
      vocabCards: [],
      shadowingClips: [{ clipId: "clip-a" }],
    });
    expect(queue).toEqual([{ kind: "shadowing", dialogueClipId: "clip-a" }]);
  });

  it("returns an empty queue when no kind has items", () => {
    expect(assembleSessionQueue({ corrections: [], vocabCards: [] })).toEqual([]);
    expect(assembleSessionQueue({ corrections: [], vocabCards: [], shadowingClips: [] })).toEqual(
      [],
    );
  });
});

describe("xpForVocabRating", () => {
  it("awards zero XP for `again` (user got the card wrong)", () => {
    expect(xpForVocabRating("again")).toBe(0);
  });

  it("awards more XP for higher confidence ratings", () => {
    expect(xpForVocabRating("hard")).toBeGreaterThan(0);
    expect(xpForVocabRating("good")).toBeGreaterThan(xpForVocabRating("hard"));
    expect(xpForVocabRating("easy")).toBeGreaterThan(xpForVocabRating("good"));
  });
});
