// Media-processing utilities used by the lesson pipeline steps.
//
// Responsibilities split between this file and @reverb/media:
//   * @reverb/media owns the ffmpeg/ffprobe shell-outs and stays Supabase-free.
//   * this file owns the Supabase storage I/O (download → temp file → process
//     → upload) and the deterministic-storage-path policy the pipeline relies
//     on for idempotent re-runs.
//
// Acceptance criteria for VOL-113 satisfied here:
//   * verifyLessonAudioDuration  — worker can verify actual duration of upload
//   * extractAndUploadLessonClip — worker can extract + upload a private clip
//   * deterministic storage paths via @reverb/media/paths
//   * silence trimming gated by MEDIA_SILENCE_TRIM_ENABLED (off by default)
//   * zero-ops: ffmpeg/ffprobe come from the static npm packages, no host
//     install or self-hosted infra is required.

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";
import {
  LESSON_CLIPS_BUCKET,
  dialogueClipPath,
  extractAudioClip,
  isSilenceTrimEnabled,
  probeDurationMs,
  rangeClipPath,
  trimLongSilences,
  type ExtractAudioClipOptions,
  type ProbeOptions,
  type TrimLongSilencesOptions,
} from "@reverb/media";
import type { ServiceClient, SourceAudio } from "./state.js";
import { type LessonAudioExtension } from "@reverb/domain/schemas/upload";

// Optional injection of the ffmpeg/ffprobe binary path + runner. Tests pass a
// fake runner here so the high-level functions can be exercised without a
// real binary; production callers leave it empty and the helpers auto-resolve.
export type MediaToolOptions = ProbeOptions & ExtractAudioClipOptions & TrimLongSilencesOptions;

// ---------- storage download/upload helpers ------------------------------

type DownloadedAudio = {
  /** Absolute path in /tmp; caller is responsible for cleanup. */
  filePath: string;
  /** Working directory we created, so the caller can wipe it in one rm. */
  workDir: string;
  byteSize: number;
};

// Reads the bytes for `source` out of private Supabase storage and lands them
// in a fresh /tmp working directory. We download rather than stream because
// ffmpeg's input-side seek (`-ss` before `-i`) needs a real seekable file —
// piping over stdin would force ffmpeg into a slow linear decode.
export async function downloadLessonAudio(
  supabase: ServiceClient,
  source: SourceAudio,
  ext: LessonAudioExtension,
): Promise<DownloadedAudio> {
  const workDir = await mkdtemp(path.join(tmpdir(), "reverb-lesson-"));
  const filePath = path.join(workDir, `source.${ext}`);
  const { data, error } = await supabase.storage.from(source.bucket).download(source.storagePath);
  if (error || !data) {
    await safeCleanup(workDir);
    throw new Error(
      `Could not download lesson audio from ${source.bucket}/${source.storagePath}: ${error?.message ?? "no body"}`,
    );
  }
  const bytes = Buffer.from(await data.arrayBuffer());
  await writeFile(filePath, bytes);
  const stats = await stat(filePath);
  return { filePath, workDir, byteSize: stats.size };
}

export async function safeCleanup(dir: string | null | undefined): Promise<void> {
  if (!dir) return;
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup. /tmp is wiped between worker runs anyway.
  }
}

// Uploads a local file into the lesson-clips bucket at `storagePath`.
// `upsert: true` is what makes the storage write idempotent — a retry that
// hits the same deterministic path overwrites the previous attempt's object
// instead of failing on the bucket's unique (bucket, path) constraint.
export async function uploadClipObject(
  supabase: ServiceClient,
  args: {
    localPath: string;
    storagePath: string;
    contentType?: string;
  },
): Promise<{ bucket: string; storagePath: string; byteSize: number }> {
  const stats = await stat(args.localPath);
  const buffer = await readFile(args.localPath);
  const { error } = await supabase.storage
    .from(LESSON_CLIPS_BUCKET)
    .upload(args.storagePath, buffer, {
      contentType: args.contentType ?? "audio/mpeg",
      upsert: true,
    });
  if (error) {
    throw new Error(
      `Could not upload clip to ${LESSON_CLIPS_BUCKET}/${args.storagePath}: ${error.message}`,
    );
  }
  return {
    bucket: LESSON_CLIPS_BUCKET,
    storagePath: args.storagePath,
    byteSize: stats.size,
  };
}

// ---------- high-level operations the worker calls ----------------------

export type VerifyDurationResult = {
  reportedDurationMs: number | null;
  actualDurationMs: number;
  /** Difference between client-reported and actual; null when reported is null. */
  driftMs: number | null;
};

// Confirms the actual decoded duration of the uploaded lesson and reports
// drift from the client's self-reported value (which the browser estimates
// before upload). The pipeline can use this to flag truncated uploads or
// detect re-encoded files; it never blocks processing on a small mismatch.
export async function verifyLessonAudioDuration(
  supabase: ServiceClient,
  source: SourceAudio,
  tools: MediaToolOptions = {},
): Promise<VerifyDurationResult> {
  const ext = pickExtension(source);
  const dl = await downloadLessonAudio(supabase, source, ext);
  try {
    const actualDurationMs = await probeDurationMs(dl.filePath, tools);
    return {
      reportedDurationMs: source.durationMs,
      actualDurationMs,
      driftMs: source.durationMs === null ? null : Math.abs(actualDurationMs - source.durationMs),
    };
  } finally {
    await safeCleanup(dl.workDir);
  }
}

export type ClipRange = {
  /** Required for path derivation (dialogue) or omitted (timestamp-only). */
  id?: string;
  startMs: number;
  endMs: number;
};

export type ExtractClipOutput = {
  bucket: string;
  storagePath: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  byteSize: number;
};

// Extracts a single clip from the uploaded lesson and persists it in the
// private lesson-clips bucket. Storage path is derived deterministically so
// the second call with identical inputs lands on the same object (idempotent
// retry). Callers that already hold the downloaded source file should use
// `extractClipFromLocalSource` to avoid re-downloading.
export async function extractAndUploadLessonClip(
  supabase: ServiceClient,
  args: {
    householdId: string;
    lessonId: string;
    source: SourceAudio;
    range: ClipRange;
    kind: "dialogue" | "vocab" | "shadowing" | "range";
  },
  tools: MediaToolOptions = {},
): Promise<ExtractClipOutput> {
  const ext = pickExtension(args.source);
  const dl = await downloadLessonAudio(supabase, args.source, ext);
  try {
    return await extractClipFromLocalSource(
      supabase,
      {
        householdId: args.householdId,
        lessonId: args.lessonId,
        localSourcePath: dl.filePath,
        range: args.range,
        kind: args.kind,
      },
      tools,
    );
  } finally {
    await safeCleanup(dl.workDir);
  }
}

// Variant that reuses a local source file — used by steps that need to pull
// many clips from the same lesson, so we only pay the download once per run.
export async function extractClipFromLocalSource(
  supabase: ServiceClient,
  args: {
    householdId: string;
    lessonId: string;
    localSourcePath: string;
    range: ClipRange;
    kind: "dialogue" | "vocab" | "shadowing" | "range";
  },
  tools: MediaToolOptions = {},
): Promise<ExtractClipOutput> {
  const storagePath = clipStoragePathFor(args);
  const scratch = await mkdtemp(path.join(tmpdir(), "reverb-clip-"));
  const outputPath = path.join(scratch, "clip.mp3");
  try {
    const clip = await extractAudioClip(
      {
        inputPath: args.localSourcePath,
        outputPath,
        startMs: args.range.startMs,
        endMs: args.range.endMs,
      },
      tools,
    );
    const uploaded = await uploadClipObject(supabase, {
      localPath: outputPath,
      storagePath,
      contentType: "audio/mpeg",
    });
    return {
      bucket: uploaded.bucket,
      storagePath: uploaded.storagePath,
      startMs: clip.startMs,
      endMs: clip.endMs,
      durationMs: clip.durationMs,
      byteSize: uploaded.byteSize,
    };
  } finally {
    await safeCleanup(scratch);
  }
}

// Optional cost-optimisation pass: trim ≥5s silences out of the uploaded
// lesson before it hits the transcription provider. Off by default — see the
// docstring in @reverb/media/silence for the rationale. When enabled, returns
// the path of the trimmed copy in the lesson-clips bucket; when disabled,
// returns `null` and the caller continues to use the original audio.
export async function maybeTrimSilenceForLessonAudio(
  supabase: ServiceClient,
  args: {
    householdId: string;
    lessonId: string;
    source: SourceAudio;
  },
  opts: { env?: NodeJS.ProcessEnv; tools?: MediaToolOptions } = {},
): Promise<{ bucket: string; storagePath: string } | null> {
  if (!isSilenceTrimEnabled(opts.env ?? process.env)) return null;
  const ext = pickExtension(args.source);
  const dl = await downloadLessonAudio(supabase, args.source, ext);
  const scratch = await mkdtemp(path.join(tmpdir(), "reverb-trim-"));
  const outputPath = path.join(scratch, "trimmed.mp3");
  try {
    await trimLongSilences({ inputPath: dl.filePath, outputPath }, opts.tools ?? {});
    const storagePath = trimmedAudioStoragePath(args.householdId, args.lessonId);
    const uploaded = await uploadClipObject(supabase, {
      localPath: outputPath,
      storagePath,
      contentType: "audio/mpeg",
    });
    return { bucket: uploaded.bucket, storagePath: uploaded.storagePath };
  } finally {
    await safeCleanup(dl.workDir);
    await safeCleanup(scratch);
  }
}

// ---------- helpers -----------------------------------------------------

function clipStoragePathFor(args: {
  householdId: string;
  lessonId: string;
  range: ClipRange;
  kind: "dialogue" | "vocab" | "shadowing" | "range";
}): string {
  if (args.kind === "dialogue") {
    // Dialogue clips carry an id from the extraction output; we use it so the
    // path links 1:1 to the DialogueClip row.
    const id = args.range.id ?? fallbackDialogueId(args.range);
    return dialogueClipPath({
      householdId: args.householdId,
      lessonId: args.lessonId,
      clipId: id,
    });
  }
  return rangeClipPath({
    householdId: args.householdId,
    lessonId: args.lessonId,
    kind: args.kind,
    startMs: args.range.startMs,
    endMs: args.range.endMs,
  });
}

// If a dialogue clip arrives without an explicit id (e.g. a future caller
// extracting a teacher correction), fall back to the start-end ms pair so we
// stay deterministic and idempotent. Random uuids here would defeat the
// retry-safety guarantee.
function fallbackDialogueId(range: ClipRange): string {
  return `${Math.round(range.startMs)}-${Math.round(range.endMs)}`;
}

function trimmedAudioStoragePath(householdId: string, lessonId: string): string {
  return `${householdId}/${lessonId}/source.trimmed.mp3`;
}

function pickExtension(source: SourceAudio): LessonAudioExtension {
  // We don't *have* to honour the original extension — ffmpeg sniffs the
  // container — but keeping it makes the temp file recognisable in logs and
  // matches the canonical extension we'd use elsewhere.
  const lower = source.storagePath.toLowerCase();
  if (lower.endsWith(".mp3")) return "mp3";
  if (lower.endsWith(".m4a")) return "m4a";
  if (lower.endsWith(".wav")) return "wav";
  if (lower.endsWith(".webm")) return "webm";
  // Fallback to mp3 — every supported mime canonicalises to one of the above,
  // so this is only reached if a future kind slips in.
  return "mp3";
}
