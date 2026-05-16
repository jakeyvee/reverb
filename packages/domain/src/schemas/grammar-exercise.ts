import { z } from "zod";
import { SCHEMA_VERSIONS } from "../versions.js";

// VOL-129: Generator output shape for "exercises about a single grammar
// pattern".
//
// The LLM is asked to produce 5+ mixed exercises per pattern. Each exercise
// is validated individually with the discriminated union below — a bad item
// (missing the fill-in marker, mismatched MC answer, empty explanation) is
// dropped without failing the run. The DB shape (`grammar_exercises`) is
// generic enough that all three kinds collapse into the same row layout;
// the discriminator only matters at validation / grading time.
//
// The fill-in-the-blank placeholder marker is fixed at `___` (three
// underscores). The generator is instructed to use it and the validator
// re-stamps the prompt to use exactly that sequence so the UI can splice an
// input field at the right offset.

export const GRAMMAR_FILL_BLANK_PLACEHOLDER = "___";

export const GRAMMAR_EXERCISE_KINDS = ["fill_blank", "multiple_choice", "transform"] as const;
export const GrammarExerciseKindSchema = z.enum(GRAMMAR_EXERCISE_KINDS);
export type GrammarExerciseKind = z.infer<typeof GrammarExerciseKindSchema>;

const TrimmedString = z.string().trim().min(1);

const fillBlankObject = z.object({
  kind: z.literal("fill_blank"),
  prompt: TrimmedString,
  answer: TrimmedString,
  explanation: TrimmedString,
  acceptedAnswers: z.array(TrimmedString).default([]),
});

const multipleChoiceObject = z.object({
  kind: z.literal("multiple_choice"),
  prompt: TrimmedString,
  answer: TrimmedString,
  explanation: TrimmedString,
  choices: z.array(TrimmedString).min(2).max(6),
});

const transformObject = z.object({
  kind: z.literal("transform"),
  prompt: TrimmedString,
  answer: TrimmedString,
  explanation: TrimmedString,
  acceptedAnswers: z.array(TrimmedString).default([]),
});

// Per-kind refinements live in `applyExerciseRefinements` so the union and
// any future standalone schemas can share the same rules. Centralising them
// here also keeps the prompt and the validator in lockstep — if a rule is
// added (e.g. "transform answer must not be identical to the prompt") it
// only changes once.
function applyExerciseRefinements(
  spec:
    | z.infer<typeof fillBlankObject>
    | z.infer<typeof multipleChoiceObject>
    | z.infer<typeof transformObject>,
  ctx: z.RefinementCtx,
): void {
  if (spec.kind === "fill_blank") {
    if (!spec.prompt.includes(GRAMMAR_FILL_BLANK_PLACEHOLDER)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["prompt"],
        message: `fill_blank prompt must contain the ${GRAMMAR_FILL_BLANK_PLACEHOLDER} placeholder`,
      });
    }
    return;
  }
  if (spec.kind === "multiple_choice") {
    const target = spec.answer.trim().toLocaleLowerCase();
    const matches = spec.choices.some((choice) => choice.trim().toLocaleLowerCase() === target);
    if (!matches) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["choices"],
        message: "choices must include the answer",
      });
    }
    const dedup = new Set(spec.choices.map((c) => c.trim().toLocaleLowerCase()));
    if (dedup.size !== spec.choices.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["choices"],
        message: "choices must be unique (case-insensitive)",
      });
    }
  }
}

export const GrammarExerciseSpecSchema = z
  .discriminatedUnion("kind", [fillBlankObject, multipleChoiceObject, transformObject])
  .superRefine((spec, ctx) => {
    applyExerciseRefinements(spec, ctx);
  });
export type GrammarExerciseSpec = z.infer<typeof GrammarExerciseSpecSchema>;

// Wrapper the generator returns: a single pattern's exercises, stamped with
// version + language. We persist `promptVersion` next to the row so a
// future migration can identify exercises emitted by an older prompt.
export const GrammarExerciseGenerationOutputSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSIONS.grammarExercise),
  promptVersion: z.string().min(1),
  language: z.string().min(2),
  patternId: z.string().min(1),
  exercises: z.array(z.unknown()).default([]),
});
export type GrammarExerciseGenerationOutput = z.infer<typeof GrammarExerciseGenerationOutputSchema>;

// Minimum exercises per pattern. The generator is instructed to emit at
// least this many; the validator filters invalid ones, and the pipeline
// flags patterns that fall under this threshold in extraction metadata so
// the team can spot consistently weak prompts without blocking the lesson.
export const GRAMMAR_EXERCISES_PER_PATTERN_MIN = 5;

// Awarded for a correct first-try answer; second try and beyond award 0 so
// the mastery dashboard can rank patterns by genuine recall.
export const GRAMMAR_EXERCISE_XP_PER_CORRECT = 5;

export type GrammarExerciseGradeResult = {
  correct: boolean;
  reason: "exact_match" | "accepted_variant" | "choice_match" | "mismatch";
};

// Loose normalization for graded answers. Mirrors normalizeCorrectionInput
// but lives here so the grammar grader and the correction-drill grader can
// evolve independently — they answer different shapes of question. The
// zero-width-space escape `\u200B` catches what browser paste sometimes
// smuggles in — using the escape (rather than the literal char) keeps the
// regex friendly to the lint no-irregular-whitespace rule.
const NORMALIZE_WHITESPACE = /[\s\u200B]+/g;
const NORMALIZE_PUNCTUATION = /^[\s.,!?;:¡¿"'`]+|[\s.,!?;:"'`]+$/g;

export function normalizeGrammarAnswer(value: string): string {
  return value
    .normalize("NFC")
    .toLocaleLowerCase()
    .replace(NORMALIZE_WHITESPACE, " ")
    .replace(NORMALIZE_PUNCTUATION, "")
    .trim();
}

export type GradeGrammarExerciseInput = {
  kind: GrammarExerciseKind;
  answer: string;
  acceptedAnswers: ReadonlyArray<string>;
  // The choices on a multiple_choice exercise. Ignored for fill_blank /
  // transform. Required for multiple_choice because the grader recognises
  // a 1-based index ("1", "2"...) as well as the literal choice text.
  choices?: ReadonlyArray<string>;
  // What the user submitted. For multiple_choice this is either the literal
  // choice text or a 1-based index passed as a string ("1", "2"...). The
  // grader normalises before comparing so the UI doesn't have to.
  userResponse: string;
};

export function gradeGrammarExercise(input: GradeGrammarExerciseInput): GrammarExerciseGradeResult {
  const submitted = normalizeGrammarAnswer(input.userResponse);
  if (submitted.length === 0) return { correct: false, reason: "mismatch" };

  if (input.kind === "multiple_choice" && input.choices) {
    const idx = Number.parseInt(input.userResponse.trim(), 10);
    if (
      Number.isInteger(idx) &&
      idx >= 1 &&
      idx <= input.choices.length &&
      normalizeGrammarAnswer(input.choices[idx - 1] ?? "") === normalizeGrammarAnswer(input.answer)
    ) {
      return { correct: true, reason: "choice_match" };
    }
  }

  if (submitted === normalizeGrammarAnswer(input.answer)) {
    return { correct: true, reason: "exact_match" };
  }
  for (const variant of input.acceptedAnswers) {
    if (submitted === normalizeGrammarAnswer(variant)) {
      return { correct: true, reason: "accepted_variant" };
    }
  }
  return { correct: false, reason: "mismatch" };
}

// Validate + filter exercises emitted by the generator. The caller passes
// the raw `exercises` array from the LLM response; we return a tuple of the
// successfully-parsed specs and the per-index errors so the pipeline can
// surface them as a soft failure (count > 0 → telemetry, but the lesson
// still completes with the surviving exercises).
export type GrammarExerciseValidationResult = {
  valid: GrammarExerciseSpec[];
  rejected: Array<{ index: number; reason: string }>;
};

export function validateGrammarExercises(
  exercises: ReadonlyArray<unknown>,
): GrammarExerciseValidationResult {
  const valid: GrammarExerciseSpec[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];
  for (let i = 0; i < exercises.length; i += 1) {
    const parsed = GrammarExerciseSpecSchema.safeParse(exercises[i]);
    if (parsed.success) {
      valid.push(parsed.data);
    } else {
      const firstIssue = parsed.error.issues[0];
      const reason = firstIssue
        ? `${firstIssue.path.join(".") || "<root>"}: ${firstIssue.message}`
        : "invalid";
      rejected.push({ index: i, reason });
    }
  }
  return { valid, rejected };
}
