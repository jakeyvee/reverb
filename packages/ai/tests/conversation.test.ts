import { describe, expect, it } from "vitest";
import type { ChatConversationContext } from "@reverb/domain";
import {
  CONVERSATION_DEFAULT_MODEL,
  CONVERSATION_PROMPT_VERSION,
  buildConversationMessages,
  buildConversationSystemPrompt,
  parseConversationResponse,
} from "../src/prompts/conversation.js";

const baseContext: ChatConversationContext = {
  level: "beginner",
  knownVocab: [
    { lemma: "kopi", translation: "coffee" },
    { lemma: "makan", translation: "to eat" },
  ],
  recentLessonVocab: [
    { lemma: "pasar", translation: "market" },
    { lemma: "jalan-jalan", translation: "to stroll" },
  ],
  recentCorrections: [
    { sourceText: "Saya pergi sekolah", correctedText: "Saya pergi ke sekolah", kind: "grammar" },
  ],
  rollingSummary: null,
};

describe("buildConversationSystemPrompt", () => {
  it("locks the assistant into Bahasa Indonesia and disallows English lectures", () => {
    const prompt = buildConversationSystemPrompt(baseContext);
    expect(prompt).toMatch(/Reply in Bahasa Indonesia/);
    expect(prompt).toMatch(/Never lecture in English/);
  });

  it("encodes level-specific guidance for beginners", () => {
    const prompt = buildConversationSystemPrompt(baseContext);
    expect(prompt).toMatch(/beginner/);
    expect(prompt).toMatch(/short, simple sentences/);
  });

  it("inlines known and recent vocab with translations", () => {
    const prompt = buildConversationSystemPrompt(baseContext);
    expect(prompt).toMatch(/kopi \(coffee\)/);
    expect(prompt).toMatch(/jalan-jalan \(to stroll\)/);
    expect(prompt).toMatch(/already mastered/);
    expect(prompt).toMatch(/recent lessons/);
  });

  it("lists prior corrections as anti-patterns the model should re-check", () => {
    const prompt = buildConversationSystemPrompt(baseContext);
    expect(prompt).toMatch(/Recent mistakes/);
    expect(prompt).toMatch(/Saya pergi sekolah/);
    expect(prompt).toMatch(/Saya pergi ke sekolah/);
  });

  it("includes the rolling summary line only when one exists", () => {
    const withSummary = buildConversationSystemPrompt({
      ...baseContext,
      rollingSummary: "We talked about coffee and the morning market.",
    });
    expect(withSummary).toMatch(/Earlier in this conversation/);
    expect(withSummary).toMatch(/coffee and the morning market/);

    const withoutSummary = buildConversationSystemPrompt(baseContext);
    expect(withoutSummary).not.toMatch(/Earlier in this conversation/);
  });

  it("specifies the strict JSON output contract", () => {
    const prompt = buildConversationSystemPrompt(baseContext);
    expect(prompt).toMatch(/Output STRICT JSON/);
    expect(prompt).toMatch(/"reply":/);
    expect(prompt).toMatch(/"corrections":/);
    expect(prompt).toMatch(/"kind": "grammar\|vocabulary\|pronunciation\|usage"/);
  });

  it("does not crash with empty vocab/correction contexts", () => {
    const prompt = buildConversationSystemPrompt({
      level: "advanced",
      knownVocab: [],
      recentLessonVocab: [],
      recentCorrections: [],
      rollingSummary: null,
    });
    expect(prompt).toMatch(/advanced/);
    expect(prompt).not.toMatch(/already mastered/);
    expect(prompt).not.toMatch(/recent lessons/);
    expect(prompt).not.toMatch(/Recent mistakes/);
  });
});

describe("buildConversationMessages", () => {
  it("forwards prior turns verbatim and appends the new user message", () => {
    const out = buildConversationMessages(
      [
        { role: "user", content: "Halo!" },
        { role: "assistant", content: "Halo! Apa kabar?" },
      ],
      "Baik, terima kasih.",
    );
    expect(out).toEqual([
      { role: "user", content: "Halo!" },
      { role: "assistant", content: "Halo! Apa kabar?" },
      { role: "user", content: "Baik, terima kasih." },
    ]);
  });

  it("handles an empty history (first turn of the session)", () => {
    const out = buildConversationMessages([], "Halo!");
    expect(out).toEqual([{ role: "user", content: "Halo!" }]);
  });
});

describe("parseConversationResponse", () => {
  it("parses a well-formed JSON payload", () => {
    const parsed = parseConversationResponse(
      JSON.stringify({
        reply: "Wah, saya juga suka kopi! Kamu suka kopi apa?",
        replyLanguage: "id",
        corrections: [
          {
            kind: "grammar",
            sourceText: "Saya pergi sekolah",
            correctedText: "Saya pergi ke sekolah",
            explanation: "Add 'ke' before destinations.",
          },
        ],
      }),
    );
    expect(parsed.reply).toMatch(/kopi/);
    expect(parsed.corrections).toHaveLength(1);
    expect(parsed.corrections[0]!.kind).toBe("grammar");
  });

  it("recovers a JSON object wrapped in stray prose", () => {
    const wrapped = `Here you go:\n\`\`\`json\n{"reply":"Halo!","corrections":[]}\n\`\`\`\nThanks!`;
    const parsed = parseConversationResponse(wrapped);
    expect(parsed.reply).toBe("Halo!");
    expect(parsed.corrections).toEqual([]);
  });

  it("throws when the response is not valid JSON", () => {
    expect(() => parseConversationResponse("oh no the model returned prose")).toThrow();
  });

  it("throws when the response is missing the reply field", () => {
    expect(() => parseConversationResponse(JSON.stringify({ corrections: [] }))).toThrow();
  });
});

describe("pinned constants", () => {
  it("pins the prompt version so a future change can be migrated forward", () => {
    expect(CONVERSATION_PROMPT_VERSION).toMatch(/^chat-/);
  });

  it("pins the default model so silent upstream changes surface in code", () => {
    expect(CONVERSATION_DEFAULT_MODEL).toMatch(/claude/);
  });
});
