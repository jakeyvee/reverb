import type { GrammarExerciseGenerationOutput } from "@reverb/domain";
import { anthropicCompletion } from "./anthropic.js";
import {
  GRAMMAR_EXERCISE_DEFAULT_MODEL,
  GRAMMAR_EXERCISE_PROMPT_VERSION,
  GRAMMAR_EXERCISE_SYSTEM_PROMPT,
  buildGrammarExerciseUserPrompt,
  parseGrammarExerciseResponse,
  type GrammarExercisePromptInput,
} from "../prompts/grammar-exercise.js";

export const ANTHROPIC_GRAMMAR_EXERCISE_PROVIDER_ID = "anthropic-grammar-exercise";

export type InferGrammarExercisesInput = GrammarExercisePromptInput & {
  /** Override the default Anthropic model for tests / experiments. */
  model?: string;
};

export type InferGrammarExercisesResult = {
  /** Domain-validated generator output (exercises still need per-item validation). */
  output: GrammarExerciseGenerationOutput;
  /** Untrimmed model response, retained for audit / debugging. */
  rawResponse: string;
  /** Model id actually used. */
  model: string;
  /** Prompt version stamped on the generated exercises. */
  promptVersion: string;
};

// Each pattern is a tiny call — the LLM gets one pattern's worth of context
// and emits a handful of exercises. 2048 tokens is plenty for ~10 mixed
// exercises with explanations; expanding generously avoids truncation if
// the model rephrases an explanation.
const MAX_TOKENS = 2048;

export async function inferGrammarExercisesWithAnthropic(
  input: InferGrammarExercisesInput,
): Promise<InferGrammarExercisesResult> {
  const model = input.model ?? GRAMMAR_EXERCISE_DEFAULT_MODEL;
  const userPrompt = buildGrammarExerciseUserPrompt(input);
  const completion = await anthropicCompletion({
    model,
    system: GRAMMAR_EXERCISE_SYSTEM_PROMPT,
    user: userPrompt,
    maxTokens: MAX_TOKENS,
  });

  const rawResponse = completion.text;
  const output = parseGrammarExerciseResponse(rawResponse, {
    patternId: input.patternId,
    language: input.language,
  });

  return {
    output,
    rawResponse,
    model,
    promptVersion: GRAMMAR_EXERCISE_PROMPT_VERSION,
  };
}
