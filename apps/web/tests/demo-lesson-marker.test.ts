import { describe, expect, it } from "vitest";
import { isDemoLessonMetadata } from "@/lib/lessons/demo";

describe("isDemoLessonMetadata", () => {
  it("returns true when metadata.demo is the boolean true", () => {
    expect(isDemoLessonMetadata({ demo: true })).toBe(true);
    expect(isDemoLessonMetadata({ demo: true, source: { kind: "seed" } })).toBe(true);
  });

  it("returns false for truthy non-true values so we don't mis-flag uploads", () => {
    expect(isDemoLessonMetadata({ demo: 1 })).toBe(false);
    expect(isDemoLessonMetadata({ demo: "true" })).toBe(false);
    expect(isDemoLessonMetadata({ demo: false })).toBe(false);
  });

  it("returns false for missing or non-object metadata", () => {
    expect(isDemoLessonMetadata(null)).toBe(false);
    expect(isDemoLessonMetadata(undefined)).toBe(false);
    expect(isDemoLessonMetadata({})).toBe(false);
    expect(isDemoLessonMetadata([])).toBe(false);
    expect(isDemoLessonMetadata("demo")).toBe(false);
  });
});
