import { describe, expect, it } from "vitest";
import {
  CORRECTION_DRILL_FAIL_INTERVAL_MINUTES,
  CORRECTION_DRILL_HIGH_CONFIDENCE,
  CORRECTION_DRILL_MIN_CONFIDENCE,
  CORRECTION_DRILL_PASS_INTERVAL_DAYS,
  CORRECTION_DRILL_RETIRE_AFTER_CONSECUTIVE_PASSES,
  classifyCorrectionConfidence,
  gradeRetypeAttempt,
  nextDrillSchedule,
  normalizeCorrectionInput,
} from "../src/schemas/correction-drill.js";

describe("classifyCorrectionConfidence", () => {
  it("treats null/undefined as eligible (older corrections were never scored)", () => {
    expect(classifyCorrectionConfidence(null)).toBe("eligible");
    expect(classifyCorrectionConfidence(undefined)).toBe("eligible");
  });

  it("drops scores below the min-confidence threshold", () => {
    expect(classifyCorrectionConfidence(CORRECTION_DRILL_MIN_CONFIDENCE - 0.001)).toBe(
      "ineligible",
    );
    expect(classifyCorrectionConfidence(0)).toBe("ineligible");
  });

  it("labels mid-band scores as uncertain", () => {
    expect(classifyCorrectionConfidence(CORRECTION_DRILL_MIN_CONFIDENCE)).toBe("uncertain");
    expect(classifyCorrectionConfidence(CORRECTION_DRILL_HIGH_CONFIDENCE - 0.001)).toBe(
      "uncertain",
    );
  });

  it("treats high-confidence scores as eligible", () => {
    expect(classifyCorrectionConfidence(CORRECTION_DRILL_HIGH_CONFIDENCE)).toBe("eligible");
    expect(classifyCorrectionConfidence(1)).toBe("eligible");
  });
});

describe("nextDrillSchedule", () => {
  const baseNow = new Date("2026-05-15T10:00:00.000Z");

  it("fails move due_at to a short retry window and reset consecutive passes", () => {
    const result = nextDrillSchedule({
      consecutivePasses: 2,
      result: "fail",
      now: baseNow,
    });
    expect(result.nextState).toBe("learning");
    expect(result.nextConsecutivePasses).toBe(0);
    expect(result.retire).toBe(false);
    expect(result.nextDueAt.getTime() - baseNow.getTime()).toBe(
      CORRECTION_DRILL_FAIL_INTERVAL_MINUTES * 60 * 1000,
    );
  });

  it("passes step due_at out by the configured day interval", () => {
    const first = nextDrillSchedule({ consecutivePasses: 0, result: "pass", now: baseNow });
    expect(first.nextConsecutivePasses).toBe(1);
    expect(first.nextState).toBe("learning");
    const firstDelay = first.nextDueAt.getTime() - baseNow.getTime();
    expect(firstDelay).toBe(CORRECTION_DRILL_PASS_INTERVAL_DAYS[0]! * 86_400_000);
  });

  it("retires the drill after the configured run of consecutive passes", () => {
    const result = nextDrillSchedule({
      consecutivePasses: CORRECTION_DRILL_RETIRE_AFTER_CONSECUTIVE_PASSES - 1,
      result: "pass",
      now: baseNow,
    });
    expect(result.nextState).toBe("retired");
    expect(result.retire).toBe(true);
    expect(result.nextConsecutivePasses).toBe(
      CORRECTION_DRILL_RETIRE_AFTER_CONSECUTIVE_PASSES,
    );
  });
});

describe("gradeRetypeAttempt + normalizeCorrectionInput", () => {
  it("treats whitespace / case / surrounding punctuation as equivalent", () => {
    expect(
      gradeRetypeAttempt({
        expected: "Saya mau kopi.",
        actual: "  saya mau kopi  ",
      }),
    ).toBe("pass");
  });

  it("returns fail for materially different text", () => {
    expect(
      gradeRetypeAttempt({
        expected: "Saya mau kopi.",
        actual: "Saya mau teh.",
      }),
    ).toBe("fail");
  });

  it("normalizes NFC composition", () => {
    const composed = "café";
    const decomposed = "café";
    expect(normalizeCorrectionInput(decomposed)).toBe(normalizeCorrectionInput(composed));
  });
});
