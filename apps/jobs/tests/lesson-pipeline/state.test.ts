import { describe, expect, it } from "vitest";
import { getCompletedStages, isStageCompleted } from "../../src/lesson-pipeline/state.js";
import { WORKER_STAGES } from "../../src/lesson-pipeline/types.js";
import { describeError } from "../../src/lesson-pipeline/orchestrator.js";

describe("getCompletedStages", () => {
  it("returns an empty map for falsy metadata", () => {
    expect(getCompletedStages(null)).toEqual({});
    expect(getCompletedStages({})).toEqual({});
    expect(getCompletedStages([] as never)).toEqual({});
  });

  it("returns the stages object as-is when present", () => {
    const meta = { stages: { transcribing: { completed_at: "t1" } } };
    expect(getCompletedStages(meta)).toEqual(meta.stages);
  });

  it("ignores non-object stage values", () => {
    expect(getCompletedStages({ stages: "nope" } as never)).toEqual({});
  });
});

describe("isStageCompleted", () => {
  it("returns true only when the stage's completed_at marker is set", () => {
    const meta = { stages: { transcribing: { completed_at: "t1" } } };
    expect(isStageCompleted(meta, "transcribing")).toBe(true);
    expect(isStageCompleted(meta, "diarizing")).toBe(false);
  });
});

describe("WORKER_STAGES", () => {
  it("excludes queued and ready (these are handled by the orchestrator)", () => {
    expect(WORKER_STAGES).toEqual(["transcribing", "diarizing", "extracting", "generating_audio"]);
  });
});

describe("describeError", () => {
  it("returns the message for an Error", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
  });
  it("truncates long messages so the column stays readable", () => {
    const long = "x".repeat(500);
    const summary = describeError(new Error(long));
    expect(summary.length).toBe(238);
    expect(summary.endsWith("…")).toBe(true);
  });
  it("falls back to a generic message for non-error throws", () => {
    expect(describeError(null)).toBe("Unknown processing error");
    expect(describeError("string error")).toBe("string error");
  });
});
