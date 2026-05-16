import { describe, expect, it } from "vitest";
import {
  CHAT_HISTORY_WINDOW,
  CHAT_SUMMARIZE_AFTER_USER_TURNS,
  ChatAssistantResponseSchema,
  ChatConversationContextSchema,
  shouldSummarizeHistory,
  windowChatHistory,
} from "../src/schemas/chat.js";

describe("windowChatHistory", () => {
  it("returns the input untouched when below the window", () => {
    const turns = Array.from({ length: 4 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `m${i}`,
    })) as { role: "user" | "assistant"; content: string }[];
    expect(windowChatHistory(turns)).toEqual(turns);
  });

  it("keeps only the most recent window turns when above the limit", () => {
    const turns = Array.from({ length: CHAT_HISTORY_WINDOW + 5 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `m${i}`,
    }));
    const out = windowChatHistory(turns);
    expect(out).toHaveLength(CHAT_HISTORY_WINDOW);
    expect(out[0]!.content).toBe(`m${turns.length - CHAT_HISTORY_WINDOW}`);
    expect(out[out.length - 1]!.content).toBe(`m${turns.length - 1}`);
  });

  it("honours a caller-supplied window override", () => {
    const turns = Array.from({ length: 6 }, (_, i) => ({
      role: "user" as const,
      content: `m${i}`,
    }));
    expect(windowChatHistory(turns, 2)).toEqual([turns[4], turns[5]]);
  });
});

describe("shouldSummarizeHistory", () => {
  it("does not summarize until the user has spoken enough", () => {
    expect(
      shouldSummarizeHistory({
        totalUserMessages: CHAT_SUMMARIZE_AFTER_USER_TURNS - 1,
        hasSummary: false,
      }),
    ).toBe(false);
  });

  it("summarizes once at the threshold even if no summary exists yet", () => {
    expect(
      shouldSummarizeHistory({
        totalUserMessages: CHAT_SUMMARIZE_AFTER_USER_TURNS,
        hasSummary: false,
      }),
    ).toBe(true);
  });

  it("skips between thresholds when a summary already exists", () => {
    expect(
      shouldSummarizeHistory({
        totalUserMessages: CHAT_SUMMARIZE_AFTER_USER_TURNS + 1,
        hasSummary: true,
      }),
    ).toBe(false);
  });

  it("re-summarizes every CHAT_SUMMARIZE_AFTER_USER_TURNS turns", () => {
    expect(
      shouldSummarizeHistory({
        totalUserMessages: CHAT_SUMMARIZE_AFTER_USER_TURNS * 2,
        hasSummary: true,
      }),
    ).toBe(true);
  });
});

describe("ChatAssistantResponseSchema", () => {
  it("defaults corrections to an empty array when the model omits the key", () => {
    const parsed = ChatAssistantResponseSchema.parse({ reply: "Halo!" });
    expect(parsed.corrections).toEqual([]);
    expect(parsed.replyLanguage).toBe("id");
  });

  it("validates correction payloads and applies the default kind", () => {
    const parsed = ChatAssistantResponseSchema.parse({
      reply: "Ya, saya suka kopi.",
      corrections: [
        {
          sourceText: "Saya suka kopinya",
          correctedText: "Saya suka kopi",
          explanation: "Drop the definite suffix for general statements.",
        },
      ],
    });
    expect(parsed.corrections[0]!.kind).toBe("grammar");
  });

  it("rejects responses without a reply (the UI relies on the field)", () => {
    expect(() => ChatAssistantResponseSchema.parse({ reply: "", corrections: [] })).toThrow();
  });
});

describe("ChatConversationContextSchema", () => {
  it("requires a level and defaults the rest", () => {
    const parsed = ChatConversationContextSchema.parse({ level: "intermediate" });
    expect(parsed.knownVocab).toEqual([]);
    expect(parsed.recentLessonVocab).toEqual([]);
    expect(parsed.recentCorrections).toEqual([]);
    expect(parsed.rollingSummary).toBeNull();
  });

  it("rejects an unknown level (the prompt only has guidance for the three canonical ones)", () => {
    expect(() => ChatConversationContextSchema.parse({ level: "fluent" })).toThrow();
  });
});
