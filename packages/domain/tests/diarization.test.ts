import { describe, expect, it } from "vitest";
import {
  DiarizationInputSchema,
  DiarizationOutputSchema,
  DiarizationSegmentLabelSchema,
} from "../src/schemas/diarization.js";
import { SCHEMA_VERSIONS } from "../src/versions.js";

const validLabel = {
  segmentId: "S0",
  speaker: "teacher",
  confidence: 0.9,
  lowPriority: false,
  notes: "leading question in Indonesian",
} as const;

const validOutput = {
  schemaVersion: SCHEMA_VERSIONS.diarization,
  promptVersion: "diarization-v1",
  model: "claude-haiku-4-5-20251001",
  sourceTranscriptId: "lesson-42",
  segments: [validLabel],
};

describe("DiarizationSegmentLabelSchema", () => {
  it("defaults lowPriority to false when omitted", () => {
    const parsed = DiarizationSegmentLabelSchema.parse({
      segmentId: "S0",
      speaker: "student_vincent",
      confidence: 0.7,
    });
    expect(parsed.lowPriority).toBe(false);
  });

  it("rejects confidence values outside [0, 1]", () => {
    expect(
      DiarizationSegmentLabelSchema.safeParse({ ...validLabel, confidence: 1.4 }).success,
    ).toBe(false);
    expect(
      DiarizationSegmentLabelSchema.safeParse({ ...validLabel, confidence: -0.1 }).success,
    ).toBe(false);
  });

  it("rejects an unknown speaker label", () => {
    const result = DiarizationSegmentLabelSchema.safeParse({ ...validLabel, speaker: "alien" });
    expect(result.success).toBe(false);
  });

  it("accepts each canonical speaker label", () => {
    for (const speaker of ["teacher", "student_vincent", "student_gf", "unknown"] as const) {
      expect(DiarizationSegmentLabelSchema.safeParse({ ...validLabel, speaker }).success).toBe(
        true,
      );
    }
  });
});

describe("DiarizationOutputSchema", () => {
  it("accepts a valid output", () => {
    const parsed = DiarizationOutputSchema.parse(validOutput);
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.promptVersion).toBe("diarization-v1");
  });

  it("rejects a wrong schemaVersion (forces a code change to roll a v2)", () => {
    expect(DiarizationOutputSchema.safeParse({ ...validOutput, schemaVersion: 2 }).success).toBe(
      false,
    );
  });

  it("requires promptVersion / model / sourceTranscriptId", () => {
    expect(DiarizationOutputSchema.safeParse({ ...validOutput, promptVersion: "" }).success).toBe(
      false,
    );
    expect(DiarizationOutputSchema.safeParse({ ...validOutput, model: "" }).success).toBe(false);
    expect(
      DiarizationOutputSchema.safeParse({ ...validOutput, sourceTranscriptId: "" }).success,
    ).toBe(false);
  });
});

describe("DiarizationInputSchema", () => {
  it("accepts an input with optional language tag on a segment", () => {
    const parsed = DiarizationInputSchema.parse({
      sourceTranscriptId: "lesson-42",
      language: "id",
      segments: [
        { id: "S0", text: "Selamat pagi.", startSec: 0, endSec: 1.2 },
        { id: "S1", text: "Good morning.", startSec: 1.3, endSec: 2.5, language: "en" },
      ],
    });
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.segments[1]?.language).toBe("en");
  });

  it("rejects empty text on a segment (would waste a label)", () => {
    expect(
      DiarizationInputSchema.safeParse({
        sourceTranscriptId: "lesson-42",
        language: "id",
        segments: [{ id: "S0", text: "", startSec: 0, endSec: 1 }],
      }).success,
    ).toBe(false);
  });
});
