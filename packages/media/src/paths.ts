// Deterministic storage paths for lesson media artefacts.
//
// Every helper here is pure and side-effect free. Worker code passes the
// household + lesson + a stable natural key (card id, dialogue clip id, …)
// and gets back the same path on every call, so a re-running stage uploads
// over the previous attempt's object rather than littering the bucket with
// duplicates. This is the "deterministic and idempotent" half of VOL-113's
// acceptance criteria.

export const LESSON_CLIPS_BUCKET = "lesson-clips" as const;

export function lessonClipsRoot(householdId: string, lessonId: string): string {
  assertNonEmpty("householdId", householdId);
  assertNonEmpty("lessonId", lessonId);
  return `${householdId}/${lessonId}/clips`;
}

// Per-card review clip — the TTS step writes here.
export function cardClipPath(args: {
  householdId: string;
  lessonId: string;
  cardId: string;
  ext?: "mp3" | "wav";
}): string {
  assertNonEmpty("cardId", args.cardId);
  return `${lessonClipsRoot(args.householdId, args.lessonId)}/cards/${args.cardId}.${args.ext ?? "mp3"}`;
}

// Original-audio dialogue excerpt — written when extraction emits a
// DialogueClip. The id matches the extractor's clip id so re-runs land on
// the same path.
export function dialogueClipPath(args: {
  householdId: string;
  lessonId: string;
  clipId: string;
  ext?: "mp3" | "wav";
}): string {
  assertNonEmpty("clipId", args.clipId);
  return `${lessonClipsRoot(args.householdId, args.lessonId)}/dialogues/${args.clipId}.${args.ext ?? "mp3"}`;
}

// Generic range-based clip path for vocab/shadowing excerpts. The natural key
// is the (rounded-ms) start/end pair so two callers asking for the same
// excerpt always land on the same object.
export function rangeClipPath(args: {
  householdId: string;
  lessonId: string;
  kind: "vocab" | "shadowing" | "range";
  startMs: number;
  endMs: number;
  ext?: "mp3" | "wav";
}): string {
  if (!Number.isFinite(args.startMs) || args.startMs < 0) {
    throw new Error(`rangeClipPath: invalid startMs ${args.startMs}`);
  }
  if (!Number.isFinite(args.endMs) || args.endMs <= args.startMs) {
    throw new Error(`rangeClipPath: endMs (${args.endMs}) must be > startMs (${args.startMs})`);
  }
  const start = Math.round(args.startMs);
  const end = Math.round(args.endMs);
  return `${lessonClipsRoot(args.householdId, args.lessonId)}/${args.kind}/${start}-${end}.${args.ext ?? "mp3"}`;
}

function assertNonEmpty(field: string, value: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} is required`);
  }
}
