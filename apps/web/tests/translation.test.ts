import { describe, expect, it } from "vitest";
import {
  TRANSLATION_PROMPT_VERSION,
  TRANSLATION_SYSTEM_PROMPT,
  buildGlossUserPrompt,
  buildTranslationUserPrompt,
  sanitizeLlmShortLine,
} from "@/lib/lessons/translation";

describe("sanitizeLlmShortLine", () => {
  it("returns the first non-empty line of the model response", () => {
    expect(sanitizeLlmShortLine("Hello world")).toBe("Hello world");
    expect(sanitizeLlmShortLine("\n\n  Hello world  \nIgnored")).toBe("Hello world");
  });

  it("strips wrapper quotes the model sometimes injects", () => {
    expect(sanitizeLlmShortLine('"Hello"')).toBe("Hello");
    expect(sanitizeLlmShortLine("'Hello'")).toBe("Hello");
    expect(sanitizeLlmShortLine("`Hello`")).toBe("Hello");
  });

  it("strips a 'Translation:' / 'Gloss:' prefix when the model echoes it", () => {
    expect(sanitizeLlmShortLine("Translation: Good morning")).toBe("Good morning");
    expect(sanitizeLlmShortLine("gloss: topic marker")).toBe("topic marker");
    expect(sanitizeLlmShortLine("Answer: hello")).toBe("hello");
  });

  it("returns empty string when the model returned nothing usable", () => {
    expect(sanitizeLlmShortLine("")).toBe("");
    expect(sanitizeLlmShortLine("\n\n  \n")).toBe("");
  });
});

describe("translation prompt builders", () => {
  it("pins the prompt version so cached translations can be invalidated", () => {
    expect(TRANSLATION_PROMPT_VERSION).toMatch(/^translate-v\d+$/);
  });

  it("includes the source-language hint when one is provided", () => {
    const prompt = buildTranslationUserPrompt({
      sourceLanguage: "id",
      targetLanguage: "en",
      text: "Selamat pagi",
    });
    expect(prompt).toContain("Source language: id");
    expect(prompt).toContain("Target language: en");
    expect(prompt).toContain("Selamat pagi");
  });

  it("falls back to 'unknown' for the source-language hint", () => {
    const prompt = buildTranslationUserPrompt({
      sourceLanguage: null,
      targetLanguage: "en",
      text: "Some sentence.",
    });
    expect(prompt).toContain("Source language: unknown");
  });

  it("wires the system prompt with one-output-line rules", () => {
    // The contract with the sanitizer is that the model returns the
    // translation alone; if these instructions ever leak through to a model
    // that ignores them, the sanitizer is the safety net.
    expect(TRANSLATION_SYSTEM_PROMPT).toMatch(/ONLY the translation/);
  });

  it("includes the clicked word and the context sentence in the gloss prompt", () => {
    const prompt = buildGlossUserPrompt({
      word: "saya",
      sentence: "Saya pergi ke sekolah.",
      sourceLanguage: "id",
      glossLanguage: "en",
    });
    expect(prompt).toContain("Word: saya");
    expect(prompt).toContain("Sentence: Saya pergi ke sekolah.");
    expect(prompt).toContain("Gloss language: en");
  });
});
