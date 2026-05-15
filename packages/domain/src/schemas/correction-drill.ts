import { z } from "zod";

export const CORRECTION_DRILL_STATES = ["new", "learning", "retired"] as const;
export const CorrectionDrillStateSchema = z.enum(CORRECTION_DRILL_STATES);
export type CorrectionDrillState = z.infer<typeof CorrectionDrillStateSchema>;

export const CORRECTION_DRILL_RESULTS = ["pass", "fail"] as const;
export const CorrectionDrillResultSchema = z.enum(CORRECTION_DRILL_RESULTS);
export type CorrectionDrillResult = z.infer<typeof CorrectionDrillResultSchema>;

// Confidence bands used by both extraction and the UI:
//
//   confidence < MIN  -> drill stays in the table for transparency but is
//                        skipped by the session selector.
//   MIN <= c < HIGH   -> drill is scheduled but labelled "uncertain" in the
//                        UI so the user knows the model wasn't sure.
//   c >= HIGH or null -> treated as fully eligible. NULL is the pre-VOL-120
//                        default, so older corrections still show up.
export const CORRECTION_DRILL_MIN_CONFIDENCE = 0.3;
export const CORRECTION_DRILL_HIGH_CONFIDENCE = 0.7;

// Scheduling parameters for the lightweight drill cadence. Mirrors a
// simplified FSRS-ish curve: short delays after a fail, lengthening intervals
// after each successful pass. Tunable in one place so the migration's stored
// state can be re-projected without code-spread.
export const CORRECTION_DRILL_RETIRE_AFTER_CONSECUTIVE_PASSES = 3;
export const CORRECTION_DRILL_FAIL_INTERVAL_MINUTES = 5;
export const CORRECTION_DRILL_PASS_INTERVAL_DAYS = [1, 3, 7] as const;

// Awarded on a successful drill attempt. Fail awards 0.
export const CORRECTION_DRILL_XP_PER_PASS = 10;

export type CorrectionConfidenceTier = "eligible" | "uncertain" | "ineligible";

export function classifyCorrectionConfidence(
  confidence: number | null | undefined,
): CorrectionConfidenceTier {
  if (confidence === null || confidence === undefined) return "eligible";
  if (confidence < CORRECTION_DRILL_MIN_CONFIDENCE) return "ineligible";
  if (confidence < CORRECTION_DRILL_HIGH_CONFIDENCE) return "uncertain";
  return "eligible";
}

export type CorrectionDrillSchedulingInput = {
  consecutivePasses: number;
  result: CorrectionDrillResult;
  now?: Date;
};

export type CorrectionDrillSchedulingOutput = {
  nextDueAt: Date;
  nextState: CorrectionDrillState;
  nextConsecutivePasses: number;
  retire: boolean;
};

// Pure function so the migration's stored counters drive a deterministic
// next-due decision. Lives in @reverb/domain so both server actions and
// future Trigger.dev jobs can call it without dragging in the web app.
export function nextDrillSchedule(
  input: CorrectionDrillSchedulingInput,
): CorrectionDrillSchedulingOutput {
  const now = input.now ?? new Date();
  if (input.result === "fail") {
    const next = new Date(
      now.getTime() + CORRECTION_DRILL_FAIL_INTERVAL_MINUTES * 60 * 1000,
    );
    return {
      nextDueAt: next,
      nextState: "learning",
      nextConsecutivePasses: 0,
      retire: false,
    };
  }
  const nextConsecutive = input.consecutivePasses + 1;
  if (nextConsecutive >= CORRECTION_DRILL_RETIRE_AFTER_CONSECUTIVE_PASSES) {
    return {
      // Once retired the row is no longer scheduled; due_at is left far in
      // the future so an accidental SELECT … ORDER BY due_at never picks it.
      nextDueAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
      nextState: "retired",
      nextConsecutivePasses: nextConsecutive,
      retire: true,
    };
  }
  const step = Math.min(
    nextConsecutive - 1,
    CORRECTION_DRILL_PASS_INTERVAL_DAYS.length - 1,
  );
  const days = CORRECTION_DRILL_PASS_INTERVAL_DAYS[step] ?? 1;
  const next = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  return {
    nextDueAt: next,
    nextState: "learning",
    nextConsecutivePasses: nextConsecutive,
    retire: false,
  };
}

// Loose normalization of typed answers for the "retype the correction" path.
// Whitespace (incl. zero-width spaces a paste might smuggle in) and
// surrounding punctuation are coalesced, NFC, lowercased. The caller still
// decides whether a self-marked attempt overrides the result.
export function normalizeCorrectionInput(value: string): string {
  return value
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\s\u200B]+/g, " ")
    .replace(/^[\s.,!?;:¡¿"'`]+|[\s.,!?;:"'`]+$/g, "")
    .trim();
}

export function gradeRetypeAttempt(args: {
  expected: string;
  actual: string;
}): CorrectionDrillResult {
  return normalizeCorrectionInput(args.expected) === normalizeCorrectionInput(args.actual)
    ? "pass"
    : "fail";
}
