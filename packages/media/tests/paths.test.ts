import { describe, expect, it } from "vitest";
import {
  LESSON_CLIPS_BUCKET,
  cardClipPath,
  dialogueClipPath,
  lessonClipsRoot,
  rangeClipPath,
} from "../src/paths.js";

const HOUSEHOLD = "h-1";
const LESSON = "l-1";

describe("clip storage paths", () => {
  it("exposes the canonical bucket id", () => {
    expect(LESSON_CLIPS_BUCKET).toBe("lesson-clips");
  });

  it("produces identical paths across calls with the same inputs (idempotency)", () => {
    const a = cardClipPath({ householdId: HOUSEHOLD, lessonId: LESSON, cardId: "card-42" });
    const b = cardClipPath({ householdId: HOUSEHOLD, lessonId: LESSON, cardId: "card-42" });
    expect(a).toBe(b);
    expect(a).toBe("h-1/l-1/clips/cards/card-42.mp3");
  });

  it("places dialogue clips under a separate prefix from card clips", () => {
    const dialogue = dialogueClipPath({
      householdId: HOUSEHOLD,
      lessonId: LESSON,
      clipId: "clip-1",
    });
    expect(dialogue).toBe("h-1/l-1/clips/dialogues/clip-1.mp3");
    expect(dialogue.startsWith(`${lessonClipsRoot(HOUSEHOLD, LESSON)}/`)).toBe(true);
  });

  it("derives range-based paths deterministically from the rounded ms window", () => {
    const a = rangeClipPath({
      householdId: HOUSEHOLD,
      lessonId: LESSON,
      kind: "shadowing",
      startMs: 1_500,
      endMs: 4_500,
    });
    const b = rangeClipPath({
      householdId: HOUSEHOLD,
      lessonId: LESSON,
      kind: "shadowing",
      startMs: 1_500.4,
      endMs: 4_500.2,
    });
    expect(a).toBe("h-1/l-1/clips/shadowing/1500-4500.mp3");
    expect(b).toBe(a);
  });

  it("rejects empty natural keys to keep paths household-scoped", () => {
    expect(() => cardClipPath({ householdId: "", lessonId: LESSON, cardId: "card-1" })).toThrow(
      /householdId/,
    );
    expect(() => cardClipPath({ householdId: HOUSEHOLD, lessonId: "", cardId: "card-1" })).toThrow(
      /lessonId/,
    );
    expect(() =>
      dialogueClipPath({ householdId: HOUSEHOLD, lessonId: LESSON, clipId: "" }),
    ).toThrow(/clipId/);
  });

  it("rejects invalid ranges in rangeClipPath", () => {
    expect(() =>
      rangeClipPath({
        householdId: HOUSEHOLD,
        lessonId: LESSON,
        kind: "vocab",
        startMs: 100,
        endMs: 100,
      }),
    ).toThrow(/endMs/);
    expect(() =>
      rangeClipPath({
        householdId: HOUSEHOLD,
        lessonId: LESSON,
        kind: "vocab",
        startMs: -1,
        endMs: 100,
      }),
    ).toThrow(/startMs/);
  });
});
