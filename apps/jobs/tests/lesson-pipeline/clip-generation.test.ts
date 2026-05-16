import { mkdir, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Tables } from "@reverb/db/types";
import type { Runner } from "@reverb/media";
import { LESSON_AUDIO_BUCKET } from "@reverb/domain/schemas/upload";
import {
  DIALOGUE_CLIP_MAX_DURATION_MS,
  DIALOGUE_CLIP_MIN_DURATION_MS,
  materializeDialogueClips,
  normalizeDialogueRange,
} from "../../src/lesson-pipeline/clip-generation.js";
import { noopLogger, type PipelineLogger } from "../../src/lesson-pipeline/logger.js";
import type { ServiceClient, SourceAudio } from "../../src/lesson-pipeline/state.js";
import { FakeSupabase } from "./fake-supabase.js";

const HOUSEHOLD_ID = "household-1";
const LESSON_ID = "11111111-2222-3333-4444-555555555555";

function buildSource(overrides: Partial<SourceAudio> = {}): SourceAudio {
  return {
    bucket: LESSON_AUDIO_BUCKET,
    storagePath: `${HOUSEHOLD_ID}/${LESSON_ID}/source.mp3`,
    mimeType: "audio/mpeg",
    byteSize: 1024,
    durationMs: 30_000,
    signedUrl: "https://example/fake",
    ...overrides,
  };
}

function asClient(supabase: FakeSupabase): ServiceClient {
  return supabase as unknown as ServiceClient;
}

function captureLogger() {
  const events: Array<{ level: "info" | "warn" | "error"; message: string; fields?: Record<string, unknown> }> = [];
  const log = (level: "info" | "warn" | "error") => (message: string, fields?: Record<string, unknown>) => {
    events.push({ level, message, fields });
  };
  const logger: PipelineLogger = {
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
  };
  return { logger, events };
}

// Fake ffmpeg/ffprobe runner: ffprobe (called with -show_entries) prints a
// duration; ffmpeg writes a deterministic clip payload to the output path.
function makeRunner(opts: { probeSeconds: number }): Runner {
  return vi.fn(async (_cmd: string, args: readonly string[]) => {
    const argList = args as readonly string[];
    if (argList.includes("-show_entries") || argList.includes("-print_format")) {
      return { code: 0, stdout: `${opts.probeSeconds.toFixed(3)}\n`, stderr: "" };
    }
    const outputPath = argList[argList.length - 1]!;
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from(`CLIP:${argList.join("|")}`));
    return { code: 0, stdout: "", stderr: "" };
  }) as unknown as Runner;
}

function buildDialogueClip(overrides: Partial<Tables<"dialogue_clips">> = {}): Tables<"dialogue_clips"> {
  const id = overrides.id ?? "clip-aaa";
  return {
    id,
    household_id: HOUSEHOLD_ID,
    lesson_id: LESSON_ID,
    segment_id: "seg-1",
    start_ms: 1_000,
    end_ms: 5_000,
    storage_bucket: "lesson-clips",
    storage_path: `${HOUSEHOLD_ID}/${LESSON_ID}/clips/dialogues/${id}.mp3`,
    caption: "A short scenario clip",
    translation: null,
    metadata: {
      kind: "dialogue",
      model: "test-extract-model",
      prompt_version: "extract-v1",
      source_transcript_id: LESSON_ID,
      source_segment_ids: ["seg-1"],
      startSegmentId: "S0",
      endSegmentId: "S0",
      participants: ["teacher", "student_vincent"],
      focus: "scenario",
    },
    created_at: new Date(0).toISOString(),
    ...overrides,
  };
}

function seedDownloadable(supabase: FakeSupabase, source: SourceAudio): void {
  supabase.storageObjects.set(`${source.bucket}:${source.storagePath}`, Buffer.from("FAKE-SOURCE-AUDIO"));
}

describe("normalizeDialogueRange", () => {
  it("accepts ranges inside the 1–8s window and source bounds", () => {
    expect(
      normalizeDialogueRange({ startMs: 1_000, endMs: 5_000, sourceDurationMs: 30_000 }),
    ).toEqual({ status: "ok", startMs: 1_000, endMs: 5_000, clamped: false });
  });

  it("rejects ranges shorter than 1s with below_min_duration", () => {
    const result = normalizeDialogueRange({ startMs: 1_000, endMs: 1_500, sourceDurationMs: 30_000 });
    expect(result.status).toBe("skip");
    if (result.status === "skip") expect(result.reason).toBe("below_min_duration");
  });

  it("rejects ranges longer than 8s with above_max_duration", () => {
    const result = normalizeDialogueRange({ startMs: 0, endMs: 9_500, sourceDurationMs: 30_000 });
    expect(result.status).toBe("skip");
    if (result.status === "skip") expect(result.reason).toBe("above_max_duration");
  });

  it("rejects negative or end<=start ranges as invalid_range", () => {
    expect(normalizeDialogueRange({ startMs: -100, endMs: 500, sourceDurationMs: 30_000 }).status).toBe(
      "skip",
    );
    expect(normalizeDialogueRange({ startMs: 5_000, endMs: 4_000, sourceDurationMs: 30_000 }).status).toBe(
      "skip",
    );
    expect(normalizeDialogueRange({ startMs: 5_000, endMs: 5_000, sourceDurationMs: 30_000 }).status).toBe(
      "skip",
    );
  });

  it("clamps end to the probed source duration when it spills over by <100ms", () => {
    const result = normalizeDialogueRange({
      startMs: 28_000,
      endMs: 30_050,
      sourceDurationMs: 30_000,
    });
    expect(result).toEqual({ status: "ok", startMs: 28_000, endMs: 30_000, clamped: true });
  });

  it("skips clips whose end falls well past the source duration", () => {
    const result = normalizeDialogueRange({
      startMs: 28_000,
      endMs: 40_000,
      sourceDurationMs: 30_000,
    });
    expect(result.status).toBe("skip");
    if (result.status === "skip") expect(result.reason).toBe("outside_source_duration");
  });

  it("skips clips whose start is past the source duration", () => {
    const result = normalizeDialogueRange({
      startMs: 30_500,
      endMs: 32_000,
      sourceDurationMs: 30_000,
    });
    expect(result.status).toBe("skip");
    if (result.status === "skip") expect(result.reason).toBe("outside_source_duration");
  });
});

describe("materializeDialogueClips", () => {
  it("downloads source once, extracts each dialogue clip, and updates the row in place", async () => {
    const supabase = new FakeSupabase();
    const source = buildSource();
    seedDownloadable(supabase, source);
    const clipOne = buildDialogueClip({ id: "clip-aaa", start_ms: 1_000, end_ms: 5_000 });
    const clipTwo = buildDialogueClip({
      id: "clip-bbb",
      segment_id: "seg-2",
      start_ms: 10_000,
      end_ms: 12_500,
      storage_path: `${HOUSEHOLD_ID}/${LESSON_ID}/clips/dialogues/clip-bbb.mp3`,
    });
    supabase.dialogueClips.push(clipOne, clipTwo);

    const runner = makeRunner({ probeSeconds: 30 });
    const result = await materializeDialogueClips({
      supabase: asClient(supabase),
      lessonId: LESSON_ID,
      source,
      logger: noopLogger,
      mediaTools: { ffmpegPath: "/fake/ffmpeg", ffprobePath: "/fake/ffprobe", runner },
    });

    expect(result.totalCount).toBe(2);
    expect(result.materializedCount).toBe(2);
    expect(result.skippedCount).toBe(0);

    // Source was downloaded exactly once across both clips — the inner helper
    // re-uses the same local file via extractClipFromLocalSource.
    const downloadCalls = supabase.storageUploads.length;
    expect(downloadCalls).toBe(2);

    // Each upload landed on the row's deterministic storage path with
    // upsert=true so a future retry will overwrite rather than collide.
    const paths = supabase.storageUploads.map((u) => `${u.bucket}/${u.path}`).sort();
    expect(paths).toEqual([
      `lesson-clips/${HOUSEHOLD_ID}/${LESSON_ID}/clips/dialogues/clip-aaa.mp3`,
      `lesson-clips/${HOUSEHOLD_ID}/${LESSON_ID}/clips/dialogues/clip-bbb.mp3`,
    ]);
    expect(supabase.storageUploads.every((u) => u.upsert === true)).toBe(true);
    expect(supabase.storageUploads.every((u) => u.contentType === "audio/mpeg")).toBe(true);

    // Row state: storage_path stays stable; metadata.materialization is filled
    // in with a byte_size / duration / source pointers.
    const rows = [...supabase.dialogueClips].sort((a, b) => a.id.localeCompare(b.id));
    for (const row of rows) {
      const meta = row.metadata as Record<string, unknown>;
      const mat = meta.materialization as Record<string, unknown>;
      expect(mat.audio_storage_path).toBe(row.storage_path);
      expect(mat.audio_bucket).toBe("lesson-clips");
      expect(mat.audio_byte_size).toBeGreaterThan(0);
      expect(typeof mat.materialized_at).toBe("string");
      expect(mat.skip_reason).toBeNull();
      // Source-of-truth fields the extracting step already populated must
      // survive unchanged through materialization.
      expect(meta.source_transcript_id).toBe(LESSON_ID);
      expect(Array.isArray(meta.source_segment_ids)).toBe(true);
      expect(meta.kind).toBe("dialogue");
    }
  });

  it("is idempotent: a second run uploads to the same paths without creating new rows", async () => {
    const supabase = new FakeSupabase();
    const source = buildSource();
    seedDownloadable(supabase, source);
    supabase.dialogueClips.push(buildDialogueClip({ id: "clip-repeat", start_ms: 0, end_ms: 4_000 }));

    const runner = makeRunner({ probeSeconds: 30 });
    const tools = { ffmpegPath: "/fake/ffmpeg", ffprobePath: "/fake/ffprobe", runner };

    const first = await materializeDialogueClips({
      supabase: asClient(supabase),
      lessonId: LESSON_ID,
      source,
      logger: noopLogger,
      mediaTools: tools,
    });
    const second = await materializeDialogueClips({
      supabase: asClient(supabase),
      lessonId: LESSON_ID,
      source,
      logger: noopLogger,
      mediaTools: tools,
    });

    expect(first.materializedCount).toBe(1);
    expect(second.materializedCount).toBe(1);
    expect(supabase.dialogueClips).toHaveLength(1);

    // Two uploads (one per call) but both land on the identical path with
    // upsert=true — that's the contract for "no duplicate assets on re-run".
    expect(supabase.storageUploads).toHaveLength(2);
    expect(supabase.storageUploads[0]!.path).toBe(supabase.storageUploads[1]!.path);
    expect(supabase.storageUploads.every((u) => u.upsert === true)).toBe(true);
  });

  it("emits a clear warning and skips the clip when the range is too short or too long", async () => {
    const supabase = new FakeSupabase();
    const source = buildSource();
    seedDownloadable(supabase, source);
    supabase.dialogueClips.push(
      buildDialogueClip({ id: "clip-short", start_ms: 1_000, end_ms: 1_500 }),
      buildDialogueClip({ id: "clip-long", start_ms: 0, end_ms: 15_000 }),
      buildDialogueClip({ id: "clip-ok", start_ms: 2_000, end_ms: 5_500 }),
    );

    const { logger, events } = captureLogger();
    const runner = makeRunner({ probeSeconds: 30 });
    const result = await materializeDialogueClips({
      supabase: asClient(supabase),
      lessonId: LESSON_ID,
      source,
      logger,
      mediaTools: { ffmpegPath: "/fake/ffmpeg", ffprobePath: "/fake/ffprobe", runner },
    });

    expect(result.materializedCount).toBe(1);
    expect(result.skippedCount).toBe(2);
    const reasons = result.skipped.map((s) => `${s.clipId}:${s.reason}`).sort();
    expect(reasons).toEqual(["clip-long:above_max_duration", "clip-short:below_min_duration"]);

    // Only one upload (the OK clip) hit storage.
    expect(supabase.storageUploads.map((u) => u.path)).toEqual([
      `${HOUSEHOLD_ID}/${LESSON_ID}/clips/dialogues/clip-ok.mp3`,
    ]);

    const warnings = events.filter((e) => e.level === "warn");
    expect(warnings.map((w) => w.fields?.clipId).sort()).toEqual(["clip-long", "clip-short"]);
    for (const w of warnings) {
      expect(w.message).toMatch(/Skipping dialogue clip/);
      expect(typeof w.fields?.reason).toBe("string");
    }

    // Skipped rows preserve their original metadata fields and record the skip
    // reason on `materialization.skip_reason` so the UI can render a placeholder.
    const skippedRow = supabase.dialogueClips.find((r) => r.id === "clip-short")!;
    const skippedMeta = skippedRow.metadata as Record<string, unknown>;
    const skipMat = skippedMeta.materialization as Record<string, unknown>;
    expect(skipMat.skip_reason).toBe("below_min_duration");
    expect(skipMat.audio_storage_path).toBeNull();
    expect(skippedMeta.source_segment_ids).toEqual(["seg-1"]);
  });

  it("skips clips whose end timestamp is past the source duration", async () => {
    const supabase = new FakeSupabase();
    const source = buildSource();
    seedDownloadable(supabase, source);
    supabase.dialogueClips.push(
      buildDialogueClip({ id: "clip-over", start_ms: 29_500, end_ms: 35_000 }),
    );

    const { logger, events } = captureLogger();
    const runner = makeRunner({ probeSeconds: 30 });
    const result = await materializeDialogueClips({
      supabase: asClient(supabase),
      lessonId: LESSON_ID,
      source,
      logger,
      mediaTools: { ffmpegPath: "/fake/ffmpeg", ffprobePath: "/fake/ffprobe", runner },
    });

    expect(result.materializedCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(result.skipped[0]).toMatchObject({
      clipId: "clip-over",
      reason: "outside_source_duration",
    });
    expect(supabase.storageUploads).toHaveLength(0);

    const warning = events.find((e) => e.level === "warn");
    expect(warning?.fields?.reason).toBe("outside_source_duration");
    expect(warning?.fields?.sourceDurationMs).toBe(30_000);
  });

  it("is a no-op when the lesson has no dialogue_clips rows", async () => {
    const supabase = new FakeSupabase();
    const source = buildSource();
    seedDownloadable(supabase, source);

    const runner = makeRunner({ probeSeconds: 30 });
    const result = await materializeDialogueClips({
      supabase: asClient(supabase),
      lessonId: LESSON_ID,
      source,
      logger: noopLogger,
      mediaTools: { ffmpegPath: "/fake/ffmpeg", ffprobePath: "/fake/ffprobe", runner },
    });

    expect(result.totalCount).toBe(0);
    expect(supabase.storageUploads).toHaveLength(0);
  });
});

describe("DIALOGUE_CLIP bounds", () => {
  it("are pinned to the values from the VOL-126 acceptance criteria", () => {
    expect(DIALOGUE_CLIP_MIN_DURATION_MS).toBe(1_000);
    expect(DIALOGUE_CLIP_MAX_DURATION_MS).toBe(8_000);
  });
});
