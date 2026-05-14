import { describe, expect, it } from "vitest";
import {
  LESSON_PROCESSING_STAGES,
  LESSON_PROCESSING_STATUSES,
  LessonProcessingStatusSchema,
  isActiveLessonStatus,
  isTerminalLessonStatus,
  lessonProcessingIdempotencyKey,
  lessonStageIndex,
  lessonStageProgress,
  lessonStatusHint,
  lessonStatusLabel,
} from "../src/schemas/lesson-status.js";

describe("lesson processing status", () => {
  it("matches the pipeline used downstream (VOL-108)", () => {
    expect(LESSON_PROCESSING_STAGES).toEqual([
      "queued",
      "transcribing",
      "diarizing",
      "extracting",
      "generating_audio",
      "ready",
    ]);
    expect(LESSON_PROCESSING_STATUSES).toEqual([...LESSON_PROCESSING_STAGES, "failed"]);
  });

  it("accepts every status via the zod schema", () => {
    for (const status of LESSON_PROCESSING_STATUSES) {
      expect(LessonProcessingStatusSchema.parse(status)).toBe(status);
    }
  });

  it("rejects unknown statuses", () => {
    expect(LessonProcessingStatusSchema.safeParse("running").success).toBe(false);
  });

  it("treats ready and failed as terminal", () => {
    expect(isTerminalLessonStatus("ready")).toBe(true);
    expect(isTerminalLessonStatus("failed")).toBe(true);
    expect(isTerminalLessonStatus("queued")).toBe(false);
    expect(isActiveLessonStatus("transcribing")).toBe(true);
    expect(isActiveLessonStatus("failed")).toBe(false);
  });

  it("orders stages monotonically", () => {
    expect(lessonStageIndex("queued")).toBe(0);
    expect(lessonStageIndex("transcribing")).toBe(1);
    expect(lessonStageIndex("ready")).toBe(LESSON_PROCESSING_STAGES.length - 1);
  });

  it("returns a label for every status", () => {
    for (const status of LESSON_PROCESSING_STATUSES) {
      expect(lessonStatusLabel(status).length).toBeGreaterThan(0);
    }
  });

  it("returns a hint for in-progress stages and null for failed", () => {
    expect(lessonStatusHint("transcribing")).toMatch(/text/i);
    expect(lessonStatusHint("failed")).toBeNull();
  });

  it("reports step progress for in-progress stages and null for failed", () => {
    expect(lessonStageProgress("queued")).toEqual({ step: 1, total: 6 });
    expect(lessonStageProgress("ready")).toEqual({ step: 6, total: 6 });
    expect(lessonStageProgress("failed")).toBeNull();
  });

  it("derives the idempotency key from the lesson id", () => {
    expect(lessonProcessingIdempotencyKey("abc-123")).toBe("process_lesson:abc-123");
  });
});
