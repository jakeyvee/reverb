// Materialise dialogue-clip audio assets from the lesson source recording.
//
// Inputs: the `dialogue_clips` rows the extracting step wrote earlier, with
// stable storage paths but no underlying audio object yet. This module is the
// step that fills the bucket — downloading the lesson once, slicing each
// requested range with ffmpeg, and uploading the resulting mp3 to the same
// deterministic path. The slice is keyed on (storage_bucket, storage_path) so
// a retry overwrites the previous attempt's object rather than appending a
// duplicate; the row is similarly updated in place.
//
// Range policy (VOL-126):
//   * dialogue shadowing clips target 1–8 seconds.
//   * negative starts, start>=end pairs, or windows that fall outside the
//     source recording are dropped with a clear warning on the logger.
//   * out-of-range clips are also marked on the row's metadata so callers can
//     surface "we couldn't make this playable" in the UI without re-deriving
//     the policy.

import type { Json, Tables } from "@reverb/db/types";
import { LESSON_CLIPS_BUCKET, probeDurationMs } from "@reverb/media";
import {
  downloadLessonAudio,
  extractClipFromLocalSource,
  safeCleanup,
  type MediaToolOptions,
} from "./media.js";
import type { ServiceClient, SourceAudio } from "./state.js";
import type { PipelineLogger } from "./logger.js";

// The acceptance criteria pin dialogue clips to a 1–8 second window. Listening
// snippets later in the product can re-use the same machinery via a different
// kind + bounds; we keep the bounds named so the constants stay grep-able.
export const DIALOGUE_CLIP_MIN_DURATION_MS = 1_000;
export const DIALOGUE_CLIP_MAX_DURATION_MS = 8_000;

// A small slack lets us accept ranges whose end falls a few ms past the probed
// duration (Whisper rounds segment ends conservatively). Anything beyond this
// is treated as a real out-of-range error and skipped.
const SOURCE_DURATION_SLACK_MS = 100;

// Reasons we emit when skipping. Strings are part of the warning payload, so
// they double as the wire format the row's metadata stores under
// `materialization.skip_reason` for UI consumers.
export type DialogueSkipReason =
  | "invalid_range"
  | "below_min_duration"
  | "above_max_duration"
  | "outside_source_duration";

export type NormalizedDialogueRange =
  | { status: "ok"; startMs: number; endMs: number; clamped: boolean }
  | { status: "skip"; reason: DialogueSkipReason; details: Record<string, unknown> };

export type NormalizeDialogueRangeInput = {
  startMs: number;
  endMs: number;
  /** Probed duration of the source audio. Null disables the bounds check. */
  sourceDurationMs: number | null;
  minDurationMs?: number;
  maxDurationMs?: number;
};

// Validates a range and clamps the end to the source duration when it spills
// over by less than `SOURCE_DURATION_SLACK_MS`. Anything coarser falls through
// as a `skip` so the caller can log and move on.
export function normalizeDialogueRange(input: NormalizeDialogueRangeInput): NormalizedDialogueRange {
  const min = input.minDurationMs ?? DIALOGUE_CLIP_MIN_DURATION_MS;
  const max = input.maxDurationMs ?? DIALOGUE_CLIP_MAX_DURATION_MS;

  if (!Number.isFinite(input.startMs) || !Number.isFinite(input.endMs)) {
    return {
      status: "skip",
      reason: "invalid_range",
      details: { startMs: input.startMs, endMs: input.endMs, note: "non-finite range" },
    };
  }

  if (input.startMs < 0 || input.endMs <= input.startMs) {
    return {
      status: "skip",
      reason: "invalid_range",
      details: { startMs: input.startMs, endMs: input.endMs },
    };
  }

  const startMs = Math.round(input.startMs);
  let endMs = Math.round(input.endMs);
  let clamped = false;

  if (input.sourceDurationMs !== null) {
    const ceiling = input.sourceDurationMs + SOURCE_DURATION_SLACK_MS;
    if (startMs >= input.sourceDurationMs) {
      return {
        status: "skip",
        reason: "outside_source_duration",
        details: { startMs, endMs, sourceDurationMs: input.sourceDurationMs },
      };
    }
    if (endMs > ceiling) {
      return {
        status: "skip",
        reason: "outside_source_duration",
        details: { startMs, endMs, sourceDurationMs: input.sourceDurationMs },
      };
    }
    if (endMs > input.sourceDurationMs) {
      endMs = input.sourceDurationMs;
      clamped = true;
    }
  }

  const duration = endMs - startMs;
  if (duration < min) {
    return {
      status: "skip",
      reason: "below_min_duration",
      details: { startMs, endMs, durationMs: duration, minDurationMs: min },
    };
  }
  if (duration > max) {
    return {
      status: "skip",
      reason: "above_max_duration",
      details: { startMs, endMs, durationMs: duration, maxDurationMs: max },
    };
  }

  return { status: "ok", startMs, endMs, clamped };
}

export type DialogueClipRow = Pick<
  Tables<"dialogue_clips">,
  | "id"
  | "household_id"
  | "lesson_id"
  | "segment_id"
  | "start_ms"
  | "end_ms"
  | "storage_bucket"
  | "storage_path"
  | "metadata"
>;

export type MaterializeDialogueClipsResult = {
  totalCount: number;
  materializedCount: number;
  skippedCount: number;
  skipped: Array<{ clipId: string; reason: DialogueSkipReason; details: Record<string, unknown> }>;
};

export type MaterializeDialogueClipsInput = {
  supabase: ServiceClient;
  lessonId: string;
  source: SourceAudio;
  logger: PipelineLogger;
  mediaTools?: MediaToolOptions;
  /** Overrides for the dialogue range policy; primarily for tests. */
  minDurationMs?: number;
  maxDurationMs?: number;
};

// Pulls every `dialogue_clips` row for the lesson, downloads the source audio
// once, then slices and uploads each clip into the private lesson-clips bucket.
// Re-running the function is safe because:
//   * the storage path is derived deterministically (see @reverb/media/paths)
//   * `upsert: true` overwrites the previous attempt's object
//   * the row update is an UPDATE keyed on (id), not an INSERT
export async function materializeDialogueClips(
  input: MaterializeDialogueClipsInput,
): Promise<MaterializeDialogueClipsResult> {
  const clips = await loadDialogueClipsForLesson(input.supabase, input.lessonId);
  if (clips.length === 0) {
    input.logger.info("No dialogue_clips rows to materialize", { lessonId: input.lessonId });
    return { totalCount: 0, materializedCount: 0, skippedCount: 0, skipped: [] };
  }

  // Reuse the same downloaded source for every clip; we only ever pay the
  // signed-URL round trip once per stage run.
  const ext = pickExtensionFromPath(input.source.storagePath);
  const download = await downloadLessonAudio(input.supabase, input.source, ext);
  let materialized = 0;
  const skipped: MaterializeDialogueClipsResult["skipped"] = [];
  try {
    const sourceDurationMs = await probeDurationMs(download.filePath, input.mediaTools ?? {});
    input.logger.info("Probed source duration for dialogue materialization", {
      lessonId: input.lessonId,
      sourceDurationMs,
      clipCount: clips.length,
    });

    for (const clip of clips) {
      const normalized = normalizeDialogueRange({
        startMs: clip.start_ms,
        endMs: clip.end_ms,
        sourceDurationMs,
        minDurationMs: input.minDurationMs,
        maxDurationMs: input.maxDurationMs,
      });

      if (normalized.status === "skip") {
        skipped.push({ clipId: clip.id, reason: normalized.reason, details: normalized.details });
        input.logger.warn("Skipping dialogue clip with unusable range", {
          lessonId: input.lessonId,
          clipId: clip.id,
          reason: normalized.reason,
          ...normalized.details,
        });
        await markClipUnmaterializable(input.supabase, clip, normalized.reason, normalized.details);
        continue;
      }

      const extracted = await extractClipFromLocalSource(
        input.supabase,
        {
          householdId: clip.household_id,
          lessonId: clip.lesson_id,
          localSourcePath: download.filePath,
          range: { id: clip.id, startMs: normalized.startMs, endMs: normalized.endMs },
          kind: "dialogue",
        },
        input.mediaTools ?? {},
      );

      // The path the extractor returns must match what the row already points
      // at; if it doesn't, the extracting step would have wired up the path
      // incorrectly. Asserting here keeps the row-to-object link honest.
      if (extracted.storagePath !== clip.storage_path) {
        throw new Error(
          `Dialogue clip ${clip.id} storage_path drift: row=${clip.storage_path} uploaded=${extracted.storagePath}`,
        );
      }

      await updateClipMaterialized(input.supabase, clip, {
        bucket: extracted.bucket,
        storagePath: extracted.storagePath,
        startMs: extracted.startMs,
        endMs: extracted.endMs,
        durationMs: extracted.durationMs,
        byteSize: extracted.byteSize,
        clamped: normalized.clamped,
        sourceDurationMs,
      });
      materialized += 1;
    }
  } finally {
    await safeCleanup(download.workDir);
  }

  input.logger.info("Materialized dialogue clips", {
    lessonId: input.lessonId,
    total: clips.length,
    materialized,
    skipped: skipped.length,
  });

  return {
    totalCount: clips.length,
    materializedCount: materialized,
    skippedCount: skipped.length,
    skipped,
  };
}

async function loadDialogueClipsForLesson(
  supabase: ServiceClient,
  lessonId: string,
): Promise<DialogueClipRow[]> {
  const { data, error } = await supabase
    .from("dialogue_clips")
    .select("id, household_id, lesson_id, segment_id, start_ms, end_ms, storage_bucket, storage_path, metadata")
    .eq("lesson_id", lessonId);
  if (error) {
    throw new Error(`Could not load dialogue_clips for lesson ${lessonId}: ${error.message}`);
  }
  return (data ?? []) as DialogueClipRow[];
}

async function updateClipMaterialized(
  supabase: ServiceClient,
  clip: DialogueClipRow,
  details: {
    bucket: string;
    storagePath: string;
    startMs: number;
    endMs: number;
    durationMs: number;
    byteSize: number;
    clamped: boolean;
    sourceDurationMs: number;
  },
): Promise<void> {
  const metadata = mergeMaterializationMetadata(clip.metadata, {
    materialized_at: new Date().toISOString(),
    audio_bucket: details.bucket,
    audio_storage_path: details.storagePath,
    audio_byte_size: details.byteSize,
    audio_duration_ms: details.durationMs,
    source_duration_ms: details.sourceDurationMs,
    range_clamped: details.clamped,
    skip_reason: null,
  });
  const { error } = await supabase
    .from("dialogue_clips")
    .update({
      storage_bucket: LESSON_CLIPS_BUCKET,
      storage_path: details.storagePath,
      start_ms: details.startMs,
      end_ms: details.endMs,
      metadata,
    })
    .eq("id", clip.id);
  if (error) {
    throw new Error(
      `Could not record materialization for dialogue_clip ${clip.id}: ${error.message}`,
    );
  }
}

async function markClipUnmaterializable(
  supabase: ServiceClient,
  clip: DialogueClipRow,
  reason: DialogueSkipReason,
  detailsExtra: Record<string, unknown>,
): Promise<void> {
  const metadata = mergeMaterializationMetadata(clip.metadata, {
    materialized_at: null,
    audio_bucket: null,
    audio_storage_path: null,
    audio_byte_size: null,
    audio_duration_ms: null,
    skip_reason: reason,
    skip_details: detailsExtra,
  });
  const { error } = await supabase
    .from("dialogue_clips")
    .update({ metadata })
    .eq("id", clip.id);
  if (error) {
    throw new Error(
      `Could not record skip reason for dialogue_clip ${clip.id}: ${error.message}`,
    );
  }
}

function mergeMaterializationMetadata(
  current: DialogueClipRow["metadata"],
  patch: Record<string, unknown>,
): Json {
  const base =
    current && typeof current === "object" && !Array.isArray(current)
      ? (current as Record<string, unknown>)
      : {};
  const existing =
    base.materialization && typeof base.materialization === "object" && !Array.isArray(base.materialization)
      ? (base.materialization as Record<string, unknown>)
      : {};
  return {
    ...base,
    materialization: { ...existing, ...patch },
  } as Json;
}

function pickExtensionFromPath(storagePath: string): "mp3" | "m4a" | "wav" | "webm" {
  const lower = storagePath.toLowerCase();
  if (lower.endsWith(".m4a")) return "m4a";
  if (lower.endsWith(".wav")) return "wav";
  if (lower.endsWith(".webm")) return "webm";
  return "mp3";
}
