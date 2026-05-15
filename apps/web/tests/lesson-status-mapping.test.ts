import { describe, expect, it } from "vitest";
import {
  mapLessonStatusRow,
  pickCount,
  pickJob,
  type RawLessonRow,
} from "@/lib/lessons/status-mapping";

function makeRow(overrides: Partial<RawLessonRow> = {}): RawLessonRow {
  return {
    id: "lesson-1",
    title: "Lesson 1",
    duration_ms: 600_000,
    created_at: "2026-05-15T12:00:00.000Z",
    lesson_jobs: {
      status: "ready",
      error_summary: null,
      attempt_count: 1,
      started_at: "2026-05-15T12:00:05.000Z",
      failed_at: null,
    },
    vocab_items: [{ count: 12 }],
    teacher_corrections: [{ count: 3 }],
    grammar_patterns: [{ count: 5 }],
    ...overrides,
  };
}

describe("pickJob", () => {
  it("returns null when the join is empty", () => {
    expect(pickJob(null)).toBeNull();
    expect(pickJob([])).toBeNull();
  });

  it("normalises both object and array shapes to the same value", () => {
    const job = {
      status: "ready" as const,
      error_summary: null,
      attempt_count: 1,
      started_at: null,
      failed_at: null,
    };
    expect(pickJob(job)).toEqual(job);
    expect(pickJob([job])).toEqual(job);
  });
});

describe("pickCount", () => {
  it("returns 0 when the aggregate is empty or missing", () => {
    expect(pickCount(null)).toBe(0);
    expect(pickCount(undefined)).toBe(0);
    expect(pickCount([])).toBe(0);
  });

  it("returns the count when present", () => {
    expect(pickCount([{ count: 7 }])).toBe(7);
    expect(pickCount([{ count: 0 }])).toBe(0);
  });
});

describe("mapLessonStatusRow", () => {
  it("maps a ready row with all extracted-content counts", () => {
    const out = mapLessonStatusRow(makeRow());
    expect(out).toEqual({
      id: "lesson-1",
      title: "Lesson 1",
      createdAt: "2026-05-15T12:00:00.000Z",
      durationMs: 600_000,
      processingStatus: "ready",
      errorSummary: null,
      attemptCount: 1,
      startedAt: "2026-05-15T12:00:05.000Z",
      failedAt: null,
      vocabCount: 12,
      correctionCount: 3,
      grammarPatternCount: 5,
    });
  });

  it("returns null when the lesson has no processing job", () => {
    expect(mapLessonStatusRow(makeRow({ lesson_jobs: null }))).toBeNull();
    expect(mapLessonStatusRow(makeRow({ lesson_jobs: [] }))).toBeNull();
  });

  it("preserves zero counts on terminal rows", () => {
    // A successfully processed lesson can legitimately yield zero corrections.
    // The mapper must surface that as `0`, not collapse to null/undefined, so
    // the archive UI can render "0" rather than "—".
    const out = mapLessonStatusRow(
      makeRow({
        teacher_corrections: [{ count: 0 }],
        grammar_patterns: null,
      }),
    );
    expect(out?.correctionCount).toBe(0);
    expect(out?.grammarPatternCount).toBe(0);
  });

  it("carries failure metadata through for the retry affordance", () => {
    const out = mapLessonStatusRow(
      makeRow({
        lesson_jobs: {
          status: "failed",
          error_summary: "Transcription timed out",
          attempt_count: 3,
          started_at: "2026-05-15T12:00:05.000Z",
          failed_at: "2026-05-15T12:01:00.000Z",
        },
      }),
    );
    expect(out?.processingStatus).toBe("failed");
    expect(out?.errorSummary).toBe("Transcription timed out");
    expect(out?.attemptCount).toBe(3);
    expect(out?.failedAt).toBe("2026-05-15T12:01:00.000Z");
  });

  it("accepts the legacy array shape for the embedded job", () => {
    const out = mapLessonStatusRow(
      makeRow({
        lesson_jobs: [
          {
            status: "transcribing",
            error_summary: null,
            attempt_count: 0,
            started_at: null,
            failed_at: null,
          },
        ],
      }),
    );
    expect(out?.processingStatus).toBe("transcribing");
  });
});
