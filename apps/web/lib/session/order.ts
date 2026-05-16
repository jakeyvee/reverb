import type { CorrectionDrillView, VocabPreview } from "./correction-drills";

export type SessionEntry =
  | { kind: "correction"; drill: CorrectionDrillView }
  | { kind: "vocab"; vocab: VocabPreview };

// Pure function so the prioritization rule has one place to live: correction
// drills always slot in ahead of fresh vocab. The DB queries already filter
// the inputs (due_at, retired, low-confidence) so this layer doesn't
// re-decide eligibility, it only orders.
export function orderDailySession(args: {
  corrections: CorrectionDrillView[];
  freshVocab: VocabPreview[];
}): SessionEntry[] {
  return [
    ...args.corrections.map<SessionEntry>((drill) => ({ kind: "correction", drill })),
    ...args.freshVocab.map<SessionEntry>((vocab) => ({ kind: "vocab", vocab })),
  ];
}
