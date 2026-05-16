import { describe, expect, it } from "vitest";
import { GRAMMAR_FILL_BLANK_PLACEHOLDER, SCHEMA_VERSIONS } from "@reverb/domain";
import {
  GRAMMAR_EXERCISE_PROMPT_VERSION,
  GRAMMAR_EXERCISE_SYSTEM_PROMPT,
  buildGrammarExerciseUserPrompt,
  parseGrammarExerciseResponse,
} from "../src/prompts/grammar-exercise.js";

// Pins the contract between the generator prompt and the validator:
//   1. the system prompt enumerates the three required kinds + JSON shape,
//   2. the user prompt round-trips the pattern id the worker provides,
//   3. the response parser re-stamps fields the model is allowed to drift
//      on (schemaVersion / promptVersion / patternId), and
//   4. malformed JSON raises so the pipeline can record a soft failure
//      for that pattern without poisoning the whole lesson.

describe("GRAMMAR_EXERCISE_SYSTEM_PROMPT", () => {
  it("mentions all three required exercise kinds", () => {
    expect(GRAMMAR_EXERCISE_SYSTEM_PROMPT).toContain("fill_blank");
    expect(GRAMMAR_EXERCISE_SYSTEM_PROMPT).toContain("multiple_choice");
    expect(GRAMMAR_EXERCISE_SYSTEM_PROMPT).toContain("transform");
  });

  it("documents the fill-in placeholder marker", () => {
    expect(GRAMMAR_EXERCISE_SYSTEM_PROMPT).toContain(GRAMMAR_FILL_BLANK_PLACEHOLDER);
  });
});

describe("buildGrammarExerciseUserPrompt", () => {
  it("round-trips the pattern id and language so the response can be attributed", () => {
    const prompt = buildGrammarExerciseUserPrompt({
      patternId: "pattern-1234",
      pattern: "ber- prefix",
      explanation: "The ber- prefix turns a noun into a verb.",
      examples: [{ target: "berjalan", gloss: "to walk" }],
      language: "id",
    });
    expect(prompt).toContain("pattern-1234");
    expect(prompt).toContain("id");
    expect(prompt).toContain("berjalan");
  });

  it("renders surrounding lesson sentences when supplied", () => {
    const prompt = buildGrammarExerciseUserPrompt({
      patternId: "pattern-1",
      pattern: "sudah + verb",
      explanation: "Marks completed action.",
      examples: [{ target: "Saya sudah makan", gloss: "I have eaten" }],
      sourceSentences: ["Selamat pagi.", "Apakah kamu sudah makan?"],
      language: "id",
    });
    expect(prompt).toContain("Selamat pagi.");
    expect(prompt).toContain("sudah makan");
  });
});

describe("parseGrammarExerciseResponse", () => {
  function buildBody(extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
      schemaVersion: SCHEMA_VERSIONS.grammarExercise,
      promptVersion: GRAMMAR_EXERCISE_PROMPT_VERSION,
      language: "id",
      patternId: "pattern-1",
      exercises: [
        {
          kind: "fill_blank",
          prompt: `Saya ${GRAMMAR_FILL_BLANK_PLACEHOLDER} kopi.`,
          answer: "mau",
          acceptedAnswers: ["mau"],
          explanation: "...",
        },
      ],
      ...extra,
    });
  }

  it("parses a well-formed response", () => {
    const out = parseGrammarExerciseResponse(buildBody(), {
      patternId: "pattern-1",
      language: "id",
    });
    expect(out.patternId).toBe("pattern-1");
    expect(out.language).toBe("id");
    expect(out.exercises).toHaveLength(1);
  });

  it("re-stamps patternId and language when the model echoed back the wrong values", () => {
    const body = JSON.stringify({
      schemaVersion: SCHEMA_VERSIONS.grammarExercise,
      promptVersion: GRAMMAR_EXERCISE_PROMPT_VERSION,
      // Model dropped to empty/missing — parser must use the caller's
      // values from `opts`.
      language: "",
      patternId: "",
      exercises: [],
    });
    const out = parseGrammarExerciseResponse(body, {
      patternId: "real-pattern",
      language: "id",
    });
    expect(out.patternId).toBe("real-pattern");
    expect(out.language).toBe("id");
  });

  it("strips a leading code fence before parsing", () => {
    const fenced = ["```json", buildBody(), "```"].join("\n");
    const out = parseGrammarExerciseResponse(fenced, {
      patternId: "pattern-1",
      language: "id",
    });
    expect(out.exercises).toHaveLength(1);
  });

  it("throws on malformed JSON so the pipeline can record a soft failure", () => {
    expect(() =>
      parseGrammarExerciseResponse("not json {", {
        patternId: "p",
        language: "id",
      }),
    ).toThrow();
  });
});
