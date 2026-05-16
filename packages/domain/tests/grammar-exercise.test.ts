import { describe, expect, it } from "vitest";
import {
  GRAMMAR_FILL_BLANK_PLACEHOLDER,
  GrammarExerciseSpecSchema,
  gradeGrammarExercise,
  normalizeGrammarAnswer,
  validateGrammarExercises,
} from "../src/schemas/grammar-exercise";

// Pure-function coverage for the VOL-129 generator + grader. Pins the
// invariants the pipeline and runner depend on:
//   1. each kind validates correctly (and bad ones are rejected with a
//      legible reason),
//   2. grading is normalization-tolerant for fill_blank / transform,
//   3. multiple_choice accepts either the literal answer or a 1-based
//      index, so the UI can post either shape.

describe("GrammarExerciseSpecSchema", () => {
  it("accepts a well-formed fill_blank spec", () => {
    const parsed = GrammarExerciseSpecSchema.safeParse({
      kind: "fill_blank",
      prompt: `Saya ${GRAMMAR_FILL_BLANK_PLACEHOLDER} kopi.`,
      answer: "mau",
      acceptedAnswers: ["mau"],
      explanation: "`mau` expresses desire.",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a fill_blank spec missing the placeholder", () => {
    const parsed = GrammarExerciseSpecSchema.safeParse({
      kind: "fill_blank",
      prompt: "Saya mau kopi.",
      answer: "mau",
      acceptedAnswers: [],
      explanation: "the answer is here",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toMatch(/placeholder/);
    }
  });

  it("rejects a multiple_choice spec whose choices omit the answer", () => {
    const parsed = GrammarExerciseSpecSchema.safeParse({
      kind: "multiple_choice",
      prompt: "Pick the right one",
      answer: "mau",
      choices: ["akan", "sudah", "lagi"],
      explanation: "...",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects multiple_choice with duplicate choices (case-insensitive)", () => {
    const parsed = GrammarExerciseSpecSchema.safeParse({
      kind: "multiple_choice",
      prompt: "Pick",
      answer: "Mau",
      choices: ["Mau", "MAU", "akan"],
      explanation: "...",
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a transform spec", () => {
    const parsed = GrammarExerciseSpecSchema.safeParse({
      kind: "transform",
      prompt: "Rewrite this in past tense using sudah: 'Saya makan.'",
      answer: "Saya sudah makan.",
      acceptedAnswers: ["Saya sudah makan"],
      explanation: "...",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("validateGrammarExercises", () => {
  it("partitions valid and rejected exercises with reasons", () => {
    const result = validateGrammarExercises([
      // valid
      {
        kind: "fill_blank",
        prompt: `Saya ${GRAMMAR_FILL_BLANK_PLACEHOLDER} kopi.`,
        answer: "mau",
        acceptedAnswers: [],
        explanation: "...",
      },
      // missing explanation
      {
        kind: "fill_blank",
        prompt: `Saya ${GRAMMAR_FILL_BLANK_PLACEHOLDER} kopi.`,
        answer: "mau",
        acceptedAnswers: [],
      },
      // valid multiple_choice
      {
        kind: "multiple_choice",
        prompt: "Pick",
        answer: "mau",
        choices: ["mau", "akan", "sudah"],
        explanation: "...",
      },
      // multiple_choice whose answer is missing from choices
      {
        kind: "multiple_choice",
        prompt: "Pick",
        answer: "mau",
        choices: ["akan", "sudah"],
        explanation: "...",
      },
    ]);
    expect(result.valid).toHaveLength(2);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected[0]?.index).toBe(1);
    expect(result.rejected[1]?.index).toBe(3);
  });
});

describe("normalizeGrammarAnswer", () => {
  it("strips surrounding punctuation, lowercases, and collapses whitespace", () => {
    expect(normalizeGrammarAnswer("  Saya Mau Kopi! ")).toBe("saya mau kopi");
    expect(normalizeGrammarAnswer("\u200B  mau  \u200B")).toBe("mau");
  });
});

describe("gradeGrammarExercise", () => {
  it("accepts an exact match for fill_blank", () => {
    const grade = gradeGrammarExercise({
      kind: "fill_blank",
      answer: "mau",
      acceptedAnswers: [],
      userResponse: "Mau",
    });
    expect(grade).toEqual({ correct: true, reason: "exact_match" });
  });

  it("accepts an accepted variant for transform", () => {
    const grade = gradeGrammarExercise({
      kind: "transform",
      answer: "Saya sudah makan.",
      acceptedAnswers: ["Sudah saya makan"],
      userResponse: "sudah saya makan",
    });
    expect(grade).toEqual({ correct: true, reason: "accepted_variant" });
  });

  it("recognises a multiple_choice 1-based index", () => {
    const grade = gradeGrammarExercise({
      kind: "multiple_choice",
      answer: "Saya sudah makan.",
      acceptedAnswers: [],
      choices: ["Saya akan makan.", "Saya sudah makan.", "Saya mau makan."],
      userResponse: "2",
    });
    expect(grade).toEqual({ correct: true, reason: "choice_match" });
  });

  it("falls back to literal-text match on multiple_choice when the input isn't a digit", () => {
    const grade = gradeGrammarExercise({
      kind: "multiple_choice",
      answer: "Saya sudah makan.",
      acceptedAnswers: [],
      choices: ["Saya akan makan.", "Saya sudah makan.", "Saya mau makan."],
      userResponse: "saya sudah makan",
    });
    expect(grade).toEqual({ correct: true, reason: "exact_match" });
  });

  it("returns mismatch when neither the canonical nor accepted variants match", () => {
    const grade = gradeGrammarExercise({
      kind: "fill_blank",
      answer: "mau",
      acceptedAnswers: ["sudah"],
      userResponse: "akan",
    });
    expect(grade).toEqual({ correct: false, reason: "mismatch" });
  });

  it("rejects an empty response", () => {
    const grade = gradeGrammarExercise({
      kind: "fill_blank",
      answer: "mau",
      acceptedAnswers: [],
      userResponse: "   ",
    });
    expect(grade.correct).toBe(false);
  });
});
