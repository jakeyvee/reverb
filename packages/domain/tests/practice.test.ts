import { describe, expect, it } from "vitest";
import {
  ListeningComprehensionItemSchema,
  MistakeDrillItemSchema,
  PRACTICE_ITEM_TYPES,
  PracticeItemSchema,
  ShadowingItemSchema,
  type PracticeItem,
} from "../src/schemas/practice.js";
import { SCHEMA_VERSIONS } from "../src/versions.js";

const base = {
  schemaVersion: SCHEMA_VERSIONS.practiceItem,
  language: "ko",
  createdAt: "2026-05-14T10:00:00.000Z",
  sourceSegmentIds: [] as string[],
};

const fixtures: Record<(typeof PRACTICE_ITEM_TYPES)[number], PracticeItem> = {
  vocab_review: {
    ...base,
    id: "p-vocab",
    type: "vocab_review",
    term: "감사합니다",
    gloss: "Thank you",
  },
  mistake_drill: {
    ...base,
    id: "p-mistake",
    type: "mistake_drill",
    utterance: "나는 갔다",
    correction: "저는 갔어요",
    studentSpeaker: "student_vincent",
  },
  grammar_exercise: {
    ...base,
    id: "p-grammar",
    type: "grammar_exercise",
    pattern: "V-아/어 보다",
    prompt: "Conjugate: 먹다 + V-아/어 보다",
    answer: "먹어 보다",
  },
  shadowing: {
    ...base,
    id: "p-shadow",
    type: "shadowing",
    audioUrl: "https://cdn.reverb.dev/audio/seg-1.mp3",
    text: "안녕하세요 여러분",
    startSec: 0,
    endSec: 2.4,
  },
  listening_comprehension: {
    ...base,
    id: "p-listen",
    type: "listening_comprehension",
    audioUrl: "https://cdn.reverb.dev/audio/seg-2.mp3",
    question: "What is the speaker ordering?",
    choices: ["coffee", "tea", "water"],
    answerIndex: 0,
  },
  scenario: {
    ...base,
    id: "p-scenario",
    type: "scenario",
    context: "Ordering at a cafe.",
    goal: "Order an iced americano politely.",
    turns: [{ speaker: "teacher", text: "주문하시겠어요?" }],
  },
  chat_turn: {
    ...base,
    id: "p-chat",
    type: "chat_turn",
    prompt: "Tell me about your weekend in Korean.",
    expectedTopics: ["weekend", "hobby"],
  },
};

describe("PracticeItemSchema", () => {
  for (const type of PRACTICE_ITEM_TYPES) {
    it(`accepts a valid ${type} item`, () => {
      expect(PracticeItemSchema.safeParse(fixtures[type]).success).toBe(true);
    });
  }

  it("rejects an unknown discriminator", () => {
    const result = PracticeItemSchema.safeParse({
      ...base,
      id: "p-bogus",
      type: "imaginary",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a shadowing item with endSec before startSec", () => {
    const result = PracticeItemSchema.safeParse({
      ...fixtures.shadowing,
      startSec: 10,
      endSec: 2,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("endSec"))).toBe(true);
    }
  });

  it("rejects a listening item whose answerIndex is out of range", () => {
    const result = PracticeItemSchema.safeParse({
      ...fixtures.listening_comprehension,
      answerIndex: 5,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("answerIndex"))).toBe(true);
    }
  });

  it("rejects a scenario item with no turns", () => {
    const result = PracticeItemSchema.safeParse({ ...fixtures.scenario, turns: [] });
    expect(result.success).toBe(false);
  });

  it("rejects a schemaVersion mismatch", () => {
    const result = PracticeItemSchema.safeParse({ ...fixtures.vocab_review, schemaVersion: 99 });
    expect(result.success).toBe(false);
  });

  it("rejects a mistake_drill whose studentSpeaker is the teacher", () => {
    const result = PracticeItemSchema.safeParse({
      ...fixtures.mistake_drill,
      studentSpeaker: "teacher",
    });
    expect(result.success).toBe(false);
  });
});

describe("standalone practice schemas enforce cross-field rules", () => {
  it("ShadowingItemSchema rejects endSec before startSec", () => {
    const result = ShadowingItemSchema.safeParse({
      ...fixtures.shadowing,
      startSec: 10,
      endSec: 2,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("endSec"))).toBe(true);
    }
  });

  it("ListeningComprehensionItemSchema rejects answerIndex out of range", () => {
    const result = ListeningComprehensionItemSchema.safeParse({
      ...fixtures.listening_comprehension,
      answerIndex: 5,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("answerIndex"))).toBe(true);
    }
  });

  it("MistakeDrillItemSchema rejects non-student speakers", () => {
    for (const speaker of ["teacher", "unknown"] as const) {
      const result = MistakeDrillItemSchema.safeParse({
        ...fixtures.mistake_drill,
        studentSpeaker: speaker,
      });
      expect(result.success).toBe(false);
    }
  });
});
