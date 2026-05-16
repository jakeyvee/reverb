import { describe, expect, it } from "vitest";
import {
  EXTRACTION_FLAG_REASONS,
  EXTRACTION_FLAG_TARGET_KINDS,
  ExtractionFlagInputSchema,
  extractionFlagReasonLabel,
} from "../src/schemas/extraction-flag";

describe("ExtractionFlagInputSchema", () => {
  it("accepts a minimal vocab flag", () => {
    const parsed = ExtractionFlagInputSchema.parse({
      targetKind: "vocab",
      targetId: "11111111-2222-3333-4444-555555555555",
      reason: "wrong_translation",
    });
    expect(parsed.notes).toBeUndefined();
  });

  it("trims free-text notes and enforces a max length", () => {
    expect(() =>
      ExtractionFlagInputSchema.parse({
        targetKind: "vocab",
        targetId: "11111111-2222-3333-4444-555555555555",
        reason: "other",
        notes: "  reviewer typo  ",
      }),
    ).not.toThrow();

    expect(() =>
      ExtractionFlagInputSchema.parse({
        targetKind: "vocab",
        targetId: "11111111-2222-3333-4444-555555555555",
        reason: "other",
        notes: "x".repeat(2001),
      }),
    ).toThrow();
  });

  it("rejects unknown target kinds and reasons", () => {
    expect(() =>
      ExtractionFlagInputSchema.parse({
        targetKind: "garbage",
        targetId: "11111111-2222-3333-4444-555555555555",
        reason: "wrong_translation",
      }),
    ).toThrow();
    expect(() =>
      ExtractionFlagInputSchema.parse({
        targetKind: "vocab",
        targetId: "11111111-2222-3333-4444-555555555555",
        reason: "garbage",
      }),
    ).toThrow();
  });

  it("rejects non-uuid target ids", () => {
    expect(() =>
      ExtractionFlagInputSchema.parse({
        targetKind: "vocab",
        targetId: "not-a-uuid",
        reason: "wrong_translation",
      }),
    ).toThrow();
  });

  it("labels every reason for the UI", () => {
    for (const reason of EXTRACTION_FLAG_REASONS) {
      expect(extractionFlagReasonLabel(reason)).toBeTruthy();
    }
  });

  it("covers every extracted-item target kind", () => {
    expect(EXTRACTION_FLAG_TARGET_KINDS).toEqual(["vocab", "grammar", "dialogue", "correction"]);
  });
});
