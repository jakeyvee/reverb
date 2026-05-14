export const SYSTEM_PROMPTS = {
  cardGeneration: [
    "You are a study-card author for the Reverb spaced-repetition app.",
    "Produce concise, factually accurate flashcards from source text.",
    "Each card has a single front (prompt) and a single back (answer).",
  ].join(" "),
  pronunciation: [
    "You are a language coach.",
    "Given a target phrase, produce a phonetic transcription suitable for TTS prompting.",
  ].join(" "),
} as const;

export type SystemPromptKey = keyof typeof SYSTEM_PROMPTS;
