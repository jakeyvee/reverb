// Self-contained Anthropic adapter for the Lesson Detail translation +
// gloss flows (VOL-130). The pipeline-side workspace (@reverb/ai) keeps the
// transcription / diarization / extraction prompts and providers; on-demand
// per-segment translation is small enough that inlining the adapter here is
// cheaper than threading a new shared module through the build graph.
//
// The Anthropic SDK is already a transitive workspace dependency (pulled in
// by @reverb/ai). Pin the model id here so a quiet upstream default change
// surfaces as a code review rather than silently changing transcript copy.

import Anthropic from "@anthropic-ai/sdk";

// Pinned identifier surfaced in server logs / future cache-busts.
export const TRANSLATION_PROMPT_VERSION = "translate-v1";

// Haiku — single-sentence translation and short word glosses fit the model's
// envelope and keep latency low for the click-to-gloss interaction.
export const TRANSLATION_DEFAULT_MODEL = "claude-haiku-4-5-20251001";

let cachedClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!cachedClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. Configure it in apps/web/.env.local before using transcript translation.",
      );
    }
    cachedClient = new Anthropic({ apiKey });
  }
  return cachedClient;
}

async function callAnthropic(args: {
  system: string;
  user: string;
  maxTokens: number;
  model: string;
}): Promise<string> {
  const client = getClient();
  const response = await client.messages.create({
    model: args.model,
    system: args.system,
    max_tokens: args.maxTokens,
    messages: [{ role: "user", content: args.user }],
  });
  const first = response.content[0];
  return first && first.type === "text" ? first.text : "";
}

export const TRANSLATION_SYSTEM_PROMPT = [
  "You translate one sentence from a one-on-one language lesson transcript.",
  "Hard rules:",
  "- Output ONLY the translation. No prose, no commentary, no markdown fences, no quotes around the result.",
  "- If the input is already in the requested target language, output the input verbatim (do not invent variation).",
  "- Preserve sentence-final punctuation (., ?, !) when the source has it.",
  "- Be natural, not literal — this text is read by an adult learner reviewing what was said in class.",
].join("\n");

export const GLOSS_SYSTEM_PROMPT = [
  "You are a bilingual dictionary for a one-on-one language lesson app.",
  "The user clicked one word in a transcript sentence and needs a one-line gloss.",
  "Hard rules:",
  "- Output ONLY the gloss. One line. No prose, no markdown, no quotes, no parentheticals like 'gloss:' or 'translation:'.",
  "- Keep it under ~80 characters. If the word has multiple senses, give the sense that fits the supplied sentence.",
  "- If the input word is already in the requested gloss language, return its base / dictionary form.",
  "- For function words (particles, articles, conjunctions) give the grammatical role in 1-3 words (e.g. 'topic marker').",
].join("\n");

export function buildTranslationUserPrompt(input: {
  sourceLanguage: string | null;
  targetLanguage: string;
  text: string;
}): string {
  const sourceHint = input.sourceLanguage ? `Source language: ${input.sourceLanguage}.` : "Source language: unknown.";
  return [
    sourceHint,
    `Target language: ${input.targetLanguage}.`,
    "",
    "Sentence:",
    input.text,
    "",
    "Translation:",
  ].join("\n");
}

export function buildGlossUserPrompt(input: {
  word: string;
  sentence: string;
  sourceLanguage: string | null;
  glossLanguage: string;
}): string {
  const sourceHint = input.sourceLanguage ? `Source language: ${input.sourceLanguage}.` : "Source language: unknown.";
  return [
    sourceHint,
    `Gloss language: ${input.glossLanguage}.`,
    `Sentence: ${input.sentence}`,
    `Word: ${input.word}`,
    "",
    "Gloss:",
  ].join("\n");
}

// Strip leading/trailing whitespace, wrapper quotes, and the occasional
// "Translation:" / "Gloss:" prefix the model still emits. We keep this
// generous: the underlying contract is "first non-empty line".
export function sanitizeLlmShortLine(raw: string): string {
  const firstLine =
    raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  let cleaned = firstLine.replace(/^["'`]+|["'`]+$/g, "").trim();
  cleaned = cleaned.replace(/^(translation|gloss|answer)\s*:\s*/i, "").trim();
  return cleaned;
}

export type TranslateSentenceInput = {
  text: string;
  sourceLanguage: string | null;
  targetLanguage: string;
  model?: string;
};

export type TranslateSentenceResult = {
  translation: string;
  model: string;
  promptVersion: string;
};

export async function translateSentence(
  input: TranslateSentenceInput,
): Promise<TranslateSentenceResult> {
  const model = input.model ?? TRANSLATION_DEFAULT_MODEL;
  const raw = await callAnthropic({
    system: TRANSLATION_SYSTEM_PROMPT,
    user: buildTranslationUserPrompt({
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      text: input.text,
    }),
    // Single sentence. 512 tokens leaves headroom for the rare long aside.
    maxTokens: 512,
    model,
  });
  const translation = sanitizeLlmShortLine(raw);
  if (translation.length === 0) {
    throw new Error("Anthropic returned an empty translation.");
  }
  return { translation, model, promptVersion: TRANSLATION_PROMPT_VERSION };
}

export type GlossWordInput = {
  word: string;
  sentence: string;
  sourceLanguage: string | null;
  glossLanguage: string;
  model?: string;
};

export type GlossWordResult = {
  gloss: string;
  model: string;
  promptVersion: string;
};

export async function glossWord(input: GlossWordInput): Promise<GlossWordResult> {
  const model = input.model ?? TRANSLATION_DEFAULT_MODEL;
  const raw = await callAnthropic({
    system: GLOSS_SYSTEM_PROMPT,
    user: buildGlossUserPrompt({
      word: input.word,
      sentence: input.sentence,
      sourceLanguage: input.sourceLanguage,
      glossLanguage: input.glossLanguage,
    }),
    // One short line. The model occasionally appends a second clause; the
    // sanitizer keeps only the first non-empty line.
    maxTokens: 128,
    model,
  });
  const gloss = sanitizeLlmShortLine(raw);
  if (gloss.length === 0) {
    throw new Error("Anthropic returned an empty gloss.");
  }
  return { gloss, model, promptVersion: TRANSLATION_PROMPT_VERSION };
}
