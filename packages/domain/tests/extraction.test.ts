import { describe, expect, it } from "vitest";
import {
  ExtractionOutputSchema,
  DialogueClipSchema,
  GrammarPatternSchema,
  NewVocabSchema,
  TeacherCorrectionSchema,
} from "../src/schemas/extraction.js";
import { SCHEMA_VERSIONS } from "../src/versions.js";

const validVocab = {
  term: "안녕하세요",
  language: "ko",
  pronunciation: "annyeonghaseyo",
  gloss: "Hello (formal)",
  example: "안녕하세요, 선생님.",
  exampleGloss: "Hello, teacher.",
  sourceSegmentIds: ["seg-1"],
  difficulty: "beginner",
} as const;

const validGrammar = {
  pattern: "V-(으)면 좋겠다",
  language: "ko",
  explanation: "Expresses a wish that something happens.",
  examples: [{ target: "비가 오면 좋겠다", gloss: "I hope it rains." }],
  sourceSegmentIds: ["seg-2"],
} as const;

const validClip = {
  id: "clip-1",
  startSegmentId: "seg-1",
  endSegmentId: "seg-3",
  startSec: 10.5,
  endSec: 25.0,
  title: "Ordering coffee",
  participants: ["teacher", "student_vincent"],
  language: "ko",
  focus: "scenario",
} as const;

const validCorrection = {
  studentSpeaker: "student_vincent",
  segmentId: "seg-4",
  utterance: "나는 학생이에요",
  correction: "저는 학생이에요",
  rationale: "Use 저 instead of 나 in polite speech.",
  category: "grammar",
  severity: "moderate",
  confidence: 0.82,
} as const;

const validPayload = {
  schemaVersion: SCHEMA_VERSIONS.extractionOutput,
  promptVersion: "extract-v1",
  language: "ko",
  sourceTranscriptId: "tr-abc",
  new_vocab: [validVocab],
  grammar_patterns: [validGrammar],
  dialogue_clips: [validClip],
  teacher_corrections: [validCorrection],
};

describe("ExtractionOutputSchema", () => {
  it("accepts a fully populated valid payload", () => {
    const parsed = ExtractionOutputSchema.parse(validPayload);
    expect(parsed.new_vocab).toHaveLength(1);
    expect(parsed.grammar_patterns).toHaveLength(1);
    expect(parsed.dialogue_clips).toHaveLength(1);
    expect(parsed.teacher_corrections).toHaveLength(1);
  });

  it("defaults empty collections when omitted", () => {
    const parsed = ExtractionOutputSchema.parse({
      schemaVersion: SCHEMA_VERSIONS.extractionOutput,
      promptVersion: "extract-v1",
      language: "ko",
      sourceTranscriptId: "tr-abc",
    });
    expect(parsed.new_vocab).toEqual([]);
    expect(parsed.grammar_patterns).toEqual([]);
    expect(parsed.dialogue_clips).toEqual([]);
    expect(parsed.teacher_corrections).toEqual([]);
  });

  it("rejects a mismatched schemaVersion", () => {
    const result = ExtractionOutputSchema.safeParse({
      ...validPayload,
      schemaVersion: 999,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["schemaVersion"]);
    }
  });

  it("rejects a missing promptVersion", () => {
    const { promptVersion: _omit, ...rest } = validPayload;
    const result = ExtractionOutputSchema.safeParse(rest);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "promptVersion")).toBe(true);
    }
  });

  it("rejects an unknown speaker label inside a clip", () => {
    const result = ExtractionOutputSchema.safeParse({
      ...validPayload,
      dialogue_clips: [{ ...validClip, participants: ["narrator"] }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a vocab entry with an empty term", () => {
    const result = NewVocabSchema.safeParse({ ...validVocab, term: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a grammar pattern with no examples", () => {
    const result = GrammarPatternSchema.safeParse({ ...validGrammar, examples: [] });
    expect(result.success).toBe(false);
  });

  it("rejects a dialogue clip with endSec before startSec", () => {
    const result = DialogueClipSchema.safeParse({ ...validClip, endSec: 1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["endSec"]);
    }
  });

  it("rejects a teacher correction with an unknown category", () => {
    const result = TeacherCorrectionSchema.safeParse({
      ...validCorrection,
      category: "vibes",
    });
    expect(result.success).toBe(false);
  });

  it("rejects extra unexpected speaker label on correction", () => {
    const result = TeacherCorrectionSchema.safeParse({
      ...validCorrection,
      studentSpeaker: "teacher's pet",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a teacher correction whose studentSpeaker is teacher/unknown", () => {
    for (const speaker of ["teacher", "unknown"] as const) {
      const result = TeacherCorrectionSchema.safeParse({
        ...validCorrection,
        studentSpeaker: speaker,
      });
      expect(result.success).toBe(false);
    }
  });

  it("accepts a teacher correction without confidence (pre-VOL-120 shape)", () => {
    const { confidence: _omit, ...rest } = validCorrection;
    expect(TeacherCorrectionSchema.safeParse(rest).success).toBe(true);
  });

  it("rejects confidence outside [0,1]", () => {
    expect(
      TeacherCorrectionSchema.safeParse({ ...validCorrection, confidence: 1.5 }).success,
    ).toBe(false);
    expect(
      TeacherCorrectionSchema.safeParse({ ...validCorrection, confidence: -0.1 }).success,
    ).toBe(false);
  });
});
