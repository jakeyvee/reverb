import { describe, expect, it } from "vitest";
import {
  isEditableTarget,
  resolveVocabReviewKey,
  type ReviewKeyEvent,
  type ReviewKeyPhase,
} from "@/lib/session/vocab-review-keys";

function evt(
  overrides: Partial<ReviewKeyEvent> & { key: string },
): ReviewKeyEvent {
  return { target: null, ...overrides };
}

describe("resolveVocabReviewKey", () => {
  it("maps Space to play-audio in every phase", () => {
    const phases: ReviewKeyPhase[] = ["prompt", "answer", "answered"];
    for (const phase of phases) {
      expect(resolveVocabReviewKey(evt({ key: " " }), phase)).toEqual({
        kind: "play-audio",
      });
      expect(resolveVocabReviewKey(evt({ key: "Spacebar" }), phase)).toEqual({
        kind: "play-audio",
      });
    }
  });

  it("maps Enter to reveal on prompt and advance on answered, but not on answer", () => {
    expect(resolveVocabReviewKey(evt({ key: "Enter" }), "prompt")).toEqual({
      kind: "reveal",
    });
    expect(resolveVocabReviewKey(evt({ key: "Enter" }), "answer")).toBeNull();
    expect(resolveVocabReviewKey(evt({ key: "Enter" }), "answered")).toEqual({
      kind: "advance",
    });
  });

  it("only treats 1-4 as ratings when an answer is on screen", () => {
    expect(resolveVocabReviewKey(evt({ key: "1" }), "answer")).toEqual({
      kind: "rate",
      rating: "again",
    });
    expect(resolveVocabReviewKey(evt({ key: "2" }), "answer")).toEqual({
      kind: "rate",
      rating: "hard",
    });
    expect(resolveVocabReviewKey(evt({ key: "3" }), "answer")).toEqual({
      kind: "rate",
      rating: "good",
    });
    expect(resolveVocabReviewKey(evt({ key: "4" }), "answer")).toEqual({
      kind: "rate",
      rating: "easy",
    });
    expect(resolveVocabReviewKey(evt({ key: "1" }), "prompt")).toBeNull();
    expect(resolveVocabReviewKey(evt({ key: "3" }), "answered")).toBeNull();
  });

  it("ignores modifier-key chords so OS shortcuts pass through", () => {
    expect(
      resolveVocabReviewKey(evt({ key: " ", metaKey: true }), "prompt"),
    ).toBeNull();
    expect(
      resolveVocabReviewKey(evt({ key: "Enter", ctrlKey: true }), "prompt"),
    ).toBeNull();
    expect(
      resolveVocabReviewKey(evt({ key: "1", altKey: true }), "answer"),
    ).toBeNull();
  });

  it("ignores keystrokes that originate inside a text input", () => {
    // resolveVocabReviewKey is duck-typed on the target — node-environment
    // tests can hand it a plain object that satisfies the structural shape.
    const fakeInput = { tagName: "INPUT" } as unknown as EventTarget;
    expect(
      resolveVocabReviewKey(evt({ key: "1", target: fakeInput }), "answer"),
    ).toBeNull();
    expect(
      resolveVocabReviewKey(evt({ key: " ", target: fakeInput }), "prompt"),
    ).toBeNull();
  });

  it("ignores keys with no binding (e.g. arrow keys, letters)", () => {
    expect(resolveVocabReviewKey(evt({ key: "ArrowLeft" }), "prompt")).toBeNull();
    expect(resolveVocabReviewKey(evt({ key: "a" }), "answer")).toBeNull();
    expect(resolveVocabReviewKey(evt({ key: "5" }), "answer")).toBeNull();
  });
});

describe("isEditableTarget", () => {
  it("returns false for a null target", () => {
    expect(isEditableTarget(null)).toBe(false);
  });

  it("returns true for INPUT, TEXTAREA, SELECT, and contenteditable", () => {
    for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) {
      expect(isEditableTarget({ tagName: tag } as unknown as EventTarget)).toBe(true);
    }
    expect(
      isEditableTarget({
        tagName: "DIV",
        isContentEditable: true,
      } as unknown as EventTarget),
    ).toBe(true);
  });

  it("returns false for non-input HTML elements", () => {
    expect(
      isEditableTarget({
        tagName: "DIV",
        isContentEditable: false,
      } as unknown as EventTarget),
    ).toBe(false);
  });
});
