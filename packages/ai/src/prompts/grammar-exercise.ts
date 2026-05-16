import {
  GRAMMAR_EXERCISES_PER_PATTERN_MIN,
  GRAMMAR_FILL_BLANK_PLACEHOLDER,
  GrammarExerciseGenerationOutputSchema,
  SCHEMA_VERSIONS,
  type GrammarExerciseGenerationOutput,
} from "@reverb/domain";

// Pinned version persisted on every generated exercise row alongside the
// model id, so a future migration can identify (and selectively reprocess)
// exercises produced by an older prompt.
export const GRAMMAR_EXERCISE_PROMPT_VERSION = "grammar-ex-v1";

// Sonnet, like extraction. Smaller models tended to skip the
// `acceptedAnswers` variants and slipped into English explanations.
export const GRAMMAR_EXERCISE_DEFAULT_MODEL = "claude-sonnet-4-6";

export type GrammarExercisePromptInput = {
  // Identifier the model round-trips. We pass the grammar_patterns row id
  // so the LLM can echo it back and downstream code can attribute each
  // emitted exercise to its source pattern without an extra lookup.
  patternId: string;
  pattern: string;
  explanation: string;
  examples: ReadonlyArray<{ target: string; gloss: string }>;
  // Up to a handful of representative segments from the source transcript
  // that triggered this pattern. Optional — the generator is asked to
  // produce *new* sentences modelled on these, not to reuse them verbatim.
  sourceSentences?: ReadonlyArray<string>;
  language: string;
};

const SAMPLE_FILL_BLANK = {
  kind: "fill_blank",
  prompt: `Saya ${GRAMMAR_FILL_BLANK_PLACEHOLDER} kopi.`,
  answer: "mau",
  acceptedAnswers: ["mau"],
  explanation: "`mau` expresses desire; it slots before the object noun.",
};

const SAMPLE_MULTIPLE_CHOICE = {
  kind: "multiple_choice",
  prompt: "Choose the form that means 'I have already eaten':",
  answer: "Saya sudah makan.",
  choices: ["Saya akan makan.", "Saya sudah makan.", "Saya mau makan.", "Saya sedang makan."],
  explanation: "`sudah` marks completed action.",
};

const SAMPLE_TRANSFORM = {
  kind: "transform",
  prompt: "Rewrite using the prefix `ber-`: 'Dia jalan ke pasar.'",
  answer: "Dia berjalan ke pasar.",
  acceptedAnswers: ["Dia berjalan ke pasar"],
  explanation: "The verb `jalan` takes the `ber-` prefix to mean 'to walk/go'.",
};

export const GRAMMAR_EXERCISE_SYSTEM_PROMPT = [
  "You are writing short grammar-practice exercises for a Bahasa Indonesia learner",
  "based on a pattern surfaced from their real Preply lesson.",
  "",
  `Emit at least ${GRAMMAR_EXERCISES_PER_PATTERN_MIN} exercises in a single JSON object.`,
  "Mix the three required kinds across the set so the learner sees variety:",
  "  - fill_blank: a target-language sentence with EXACTLY one occurrence of",
  `    the placeholder ${GRAMMAR_FILL_BLANK_PLACEHOLDER}. The answer is the word/phrase`,
  "    that fills the placeholder. List common acceptable variants in",
  "    `acceptedAnswers` (e.g. spelling alternatives, contractions). The",
  "    placeholder MUST appear in the prompt exactly as three underscores.",
  "  - multiple_choice: a question + 3-5 distinct choices. The answer MUST",
  "    appear verbatim as one of the choices. Distractors should be",
  "    plausible but unambiguously wrong.",
  "  - transform: ask the learner to rewrite an input sentence using the",
  "    target pattern (e.g. 'Make this past tense using `sudah`'). Provide",
  "    the canonical rewrite in `answer`; list alternate phrasings in",
  "    `acceptedAnswers` when they are also correct.",
  "",
  "Hard rules — violations fail validation and the exercise is silently dropped:",
  "- `prompt`, `answer`, `explanation` must be non-empty strings.",
  "- `explanation` must briefly justify the answer in English so the learner",
  "  can review why their attempt was correct/incorrect.",
  "- All target-language text (prompt body, answer, accepted variants,",
  "  choices, transform inputs) must be in the lesson language — never an",
  "  English translation. `explanation` is the only English-allowed field.",
  "- For multiple_choice: `choices` must include the literal `answer` and",
  "  must be unique (case-insensitive).",
  "- Do NOT reuse the source sentences verbatim — model new sentences on",
  "  the pattern and the examples provided.",
  "",
  "Schema and versioning:",
  `- Set schemaVersion to the integer ${SCHEMA_VERSIONS.grammarExercise}.`,
  `- Set promptVersion to "${GRAMMAR_EXERCISE_PROMPT_VERSION}".`,
  "- Set language to the lesson language passed in the user message.",
  "- Set patternId to the value passed in the user message.",
  "",
  "Output STRICT JSON, no prose, no markdown fences. Exact shape:",
  "{",
  `  "schemaVersion": ${SCHEMA_VERSIONS.grammarExercise},`,
  `  "promptVersion": "${GRAMMAR_EXERCISE_PROMPT_VERSION}",`,
  '  "language": "<bcp47>",',
  '  "patternId": "<pattern id>",',
  '  "exercises": [',
  "    " + JSON.stringify(SAMPLE_FILL_BLANK) + ",",
  "    " + JSON.stringify(SAMPLE_MULTIPLE_CHOICE) + ",",
  "    " + JSON.stringify(SAMPLE_TRANSFORM),
  "  ]",
  "}",
].join("\n");

export function buildGrammarExerciseUserPrompt(input: GrammarExercisePromptInput): string {
  const lines: string[] = [];
  lines.push(`Lesson language: ${input.language}.`);
  lines.push(`Pattern id: ${input.patternId}.`);
  lines.push(`Pattern: ${input.pattern}.`);
  lines.push(`Explanation: ${input.explanation}`);
  if (input.examples.length > 0) {
    lines.push("");
    lines.push("Examples from the lesson (target — gloss):");
    for (const ex of input.examples) {
      lines.push(`- ${ex.target} — ${ex.gloss}`);
    }
  }
  if (input.sourceSentences && input.sourceSentences.length > 0) {
    lines.push("");
    lines.push("Surrounding lesson sentences (for context — do not reuse verbatim):");
    for (const sentence of input.sourceSentences) {
      lines.push(`- ${sentence}`);
    }
  }
  lines.push("");
  lines.push(
    `Return the JSON object now. At least ${GRAMMAR_EXERCISES_PER_PATTERN_MIN} mixed-kind exercises. No prose.`,
  );
  return lines.join("\n");
}

// Extract the outermost JSON object from the model response. Mirrors the
// extraction parser: Anthropic usually returns a clean object, but
// occasionally wraps it in markdown fences or a leading sentence.
function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Grammar exercise response did not contain a JSON object");
  }
  return trimmed.slice(start, end + 1);
}

export type ParseGrammarExerciseResponseOptions = {
  patternId: string;
  language: string;
};

export function parseGrammarExerciseResponse(
  raw: string,
  opts: ParseGrammarExerciseResponseOptions,
): GrammarExerciseGenerationOutput {
  const json = extractJsonObject(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `Grammar exercise response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Re-stamp the fields the model is not allowed to drift on. The strict
  // zod parse below still fails the run if the LLM emitted a wrong literal
  // value — but for routine drift (model echoes "id" instead of the actual
  // pattern id) we override here so the run survives.
  const candidate = parsed as Record<string, unknown>;
  const output = {
    schemaVersion: SCHEMA_VERSIONS.grammarExercise,
    promptVersion:
      typeof candidate.promptVersion === "string" && candidate.promptVersion.length > 0
        ? candidate.promptVersion
        : GRAMMAR_EXERCISE_PROMPT_VERSION,
    language:
      typeof candidate.language === "string" && candidate.language.length >= 2
        ? candidate.language
        : opts.language,
    patternId:
      typeof candidate.patternId === "string" && candidate.patternId.length > 0
        ? candidate.patternId
        : opts.patternId,
    exercises: Array.isArray(candidate.exercises) ? candidate.exercises : [],
  };

  return GrammarExerciseGenerationOutputSchema.parse(output);
}
