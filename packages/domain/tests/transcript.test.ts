import { describe, expect, it } from "vitest";
import {
  TranscriptSchema,
  TranscriptSegmentSchema,
  WordTimestampSchema,
} from "../src/schemas/transcript.js";
import { SCHEMA_VERSIONS } from "../src/versions.js";

const validSegment = {
  id: "seg-1",
  speaker: "teacher",
  text: "안녕하세요 여러분",
  start: 0,
  end: 2.4,
  words: [
    { word: "안녕하세요", start: 0, end: 1.2 },
    { word: "여러분", start: 1.2, end: 2.4, confidence: 0.93 },
  ],
  confidence: 0.95,
  language: "ko",
} as const;

const validTranscript = {
  schemaVersion: SCHEMA_VERSIONS.transcript,
  sourceId: "lesson-42",
  language: "ko",
  durationSec: 600,
  provider: "groq-whisper",
  model: "whisper-large-v3",
  createdAt: "2026-05-14T10:00:00.000Z",
  segments: [validSegment],
};

describe("TranscriptSchema", () => {
  it("accepts a valid transcript", () => {
    const parsed = TranscriptSchema.parse(validTranscript);
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.segments[0]?.speaker).toBe("teacher");
  });

  it("rejects a word timestamp with end before start", () => {
    const result = WordTimestampSchema.safeParse({
      word: "안녕",
      start: 2,
      end: 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a segment with end before start", () => {
    const result = TranscriptSegmentSchema.safeParse({
      ...validSegment,
      start: 5,
      end: 2,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown speaker label", () => {
    const result = TranscriptSchema.safeParse({
      ...validTranscript,
      segments: [{ ...validSegment, speaker: "alien" }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts each canonical speaker label", () => {
    for (const speaker of ["teacher", "student_vincent", "student_gf", "unknown"] as const) {
      const result = TranscriptSegmentSchema.safeParse({ ...validSegment, speaker });
      expect(result.success).toBe(true);
    }
  });
});
