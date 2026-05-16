import type { ReviewRating } from "@reverb/domain/schemas/review";

// Phase the runner can be in when a key fires. The shortcuts available depend
// on what's on screen — you can't rate a card whose answer you haven't
// flipped yet, and you can't "continue" until a rating has been recorded.
export type ReviewKeyPhase = "prompt" | "answer" | "answered";

export type ReviewKeyAction =
  | { kind: "play-audio" }
  | { kind: "reveal" }
  | { kind: "rate"; rating: ReviewRating }
  | { kind: "advance" };

// Minimal subset of KeyboardEvent we read. Lets us unit-test the resolver
// without standing up a DOM event.
export type ReviewKeyEvent = {
  key: string;
  target: EventTarget | null;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
};

// Tags whose default behaviour reads keystrokes (typing). The runner must
// stay out of the way of any text input on the page, including the
// correction-drill Retype field if that runner is mounted alongside.
const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

// Duck-typed shape we care about. The real DOM event delivers an HTMLElement
// here, but using the structural type keeps the helper unit-testable in a
// node environment (Vitest doesn't load jsdom for this project).
type MaybeEditable = {
  tagName?: unknown;
  isContentEditable?: unknown;
};

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target) return false;
  const candidate = target as MaybeEditable;
  if (typeof candidate.tagName === "string" && EDITABLE_TAGS.has(candidate.tagName)) {
    return true;
  }
  // `contenteditable` covers rich-text widgets and CodeMirror-style editors.
  if (candidate.isContentEditable === true) return true;
  return false;
}

// Pure shortcut resolver: given a key event and the current phase, decide
// which action the runner should take. Returns `null` when no shortcut
// applies — the caller leaves the event alone (no preventDefault).
//
// Bindings:
//   * Space  -> play audio (any phase, so the user can re-listen on the back).
//   * Enter  -> reveal (on prompt) or advance (on answered feedback).
//   * 1..4   -> Again/Hard/Good/Easy when an answer is on screen.
export function resolveVocabReviewKey(
  event: ReviewKeyEvent,
  phase: ReviewKeyPhase,
): ReviewKeyAction | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (isEditableTarget(event.target)) return null;

  switch (event.key) {
    case " ":
    case "Spacebar":
      return { kind: "play-audio" };
    case "Enter":
      if (phase === "prompt") return { kind: "reveal" };
      if (phase === "answered") return { kind: "advance" };
      return null;
    case "1":
      return phase === "answer" ? { kind: "rate", rating: "again" } : null;
    case "2":
      return phase === "answer" ? { kind: "rate", rating: "hard" } : null;
    case "3":
      return phase === "answer" ? { kind: "rate", rating: "good" } : null;
    case "4":
      return phase === "answer" ? { kind: "rate", rating: "easy" } : null;
    default:
      return null;
  }
}
