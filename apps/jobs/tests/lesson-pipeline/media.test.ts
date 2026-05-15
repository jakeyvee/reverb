import { describe, expect, it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import path from "node:path";
import { LESSON_AUDIO_BUCKET } from "@reverb/domain/schemas/upload";
import type { Runner } from "@reverb/media";
import {
  extractAndUploadLessonClip,
  extractClipFromLocalSource,
  maybeTrimSilenceForLessonAudio,
  verifyLessonAudioDuration,
} from "../../src/lesson-pipeline/media.js";
import type { ServiceClient, SourceAudio } from "../../src/lesson-pipeline/state.js";

const HOUSEHOLD = "h-1";
const LESSON = "lesson-1";

function buildSource(overrides: Partial<SourceAudio> = {}): SourceAudio {
  return {
    bucket: LESSON_AUDIO_BUCKET,
    storagePath: `${HOUSEHOLD}/${LESSON}/source.mp3`,
    mimeType: "audio/mpeg",
    byteSize: 1024,
    durationMs: 60_000,
    signedUrl: "https://example/fake",
    ...overrides,
  };
}

// Minimal storage fake: serves a fixed payload on download, captures every
// upload so the test can assert the (bucket, path, options) trio.
class FakeStorage {
  uploads: Array<{
    bucket: string;
    path: string;
    bytes: Buffer;
    contentType?: string;
    upsert?: boolean;
  }> = [];
  downloads: Array<{ bucket: string; path: string }> = [];
  downloadBody: Buffer;
  uploadError: string | null = null;
  downloadError: string | null = null;

  constructor(downloadBody: Buffer) {
    this.downloadBody = downloadBody;
  }

  from(bucket: string) {
    return {
      download: async (path: string) => {
        this.downloads.push({ bucket, path });
        if (this.downloadError) {
          return { data: null, error: { message: this.downloadError } };
        }
        const data = {
          arrayBuffer: async () =>
            this.downloadBody.buffer.slice(
              this.downloadBody.byteOffset,
              this.downloadBody.byteOffset + this.downloadBody.byteLength,
            ),
        };
        return { data, error: null };
      },
      upload: async (
        path: string,
        body: ArrayBufferView | ArrayBuffer | Buffer,
        opts?: { contentType?: string; upsert?: boolean },
      ) => {
        if (this.uploadError) {
          return { data: null, error: { message: this.uploadError } };
        }
        const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body as ArrayBuffer);
        this.uploads.push({
          bucket,
          path,
          bytes: buffer,
          contentType: opts?.contentType,
          upsert: opts?.upsert,
        });
        return { data: { id: path, path, fullPath: `${bucket}/${path}` }, error: null };
      },
    };
  }
}

function asClient(storage: FakeStorage): ServiceClient {
  // The media module only touches supabase.storage; the rest of the
  // supabase-js surface is not exercised by these tests.
  return { storage } as unknown as ServiceClient;
}

describe("verifyLessonAudioDuration", () => {
  it("downloads from the source bucket, calls ffprobe, and reports drift", async () => {
    const fakeAudio = Buffer.from("ID3-FAKE-MP3-BODY");
    const storage = new FakeStorage(fakeAudio);
    const runner: Runner = vi.fn().mockResolvedValue({ code: 0, stdout: "62.500\n", stderr: "" });

    const result = await verifyLessonAudioDuration(
      asClient(storage),
      buildSource({ durationMs: 60_000 }),
      { ffprobePath: "/fake/ffprobe", runner },
    );

    expect(result.actualDurationMs).toBe(62_500);
    expect(result.reportedDurationMs).toBe(60_000);
    expect(result.driftMs).toBe(2_500);
    expect(storage.downloads).toEqual([
      { bucket: LESSON_AUDIO_BUCKET, path: `${HOUSEHOLD}/${LESSON}/source.mp3` },
    ]);

    // The first arg of the runner call is the resolved ffprobe binary; the
    // last positional arg should be the freshly downloaded /tmp file path.
    const [, args] = (runner as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const lastArg = (args as string[])[(args as string[]).length - 1]!;
    expect(lastArg.endsWith("source.mp3")).toBe(true);
    expect(lastArg.includes("reverb-lesson-")).toBe(true);
  });

  it("reports driftMs=null when the lesson_files row has no client duration", async () => {
    const storage = new FakeStorage(Buffer.from("x"));
    const runner: Runner = vi.fn().mockResolvedValue({ code: 0, stdout: "10.0\n", stderr: "" });

    const result = await verifyLessonAudioDuration(
      asClient(storage),
      buildSource({ durationMs: null }),
      { ffprobePath: "/fake/ffprobe", runner },
    );
    expect(result.driftMs).toBeNull();
    expect(result.actualDurationMs).toBe(10_000);
  });

  it("surfaces a clear error when supabase storage refuses the download", async () => {
    const storage = new FakeStorage(Buffer.from(""));
    storage.downloadError = "Object not found";
    const runner: Runner = vi.fn();

    await expect(
      verifyLessonAudioDuration(asClient(storage), buildSource(), {
        ffprobePath: "/fake/ffprobe",
        runner,
      }),
    ).rejects.toThrow(/Could not download lesson audio.*Object not found/);
    expect(runner).not.toHaveBeenCalled();
  });
});

describe("extractAndUploadLessonClip", () => {
  it("extracts a dialogue clip and uploads it to the deterministic dialogue path", async () => {
    const storage = new FakeStorage(Buffer.from("FAKE-MP3"));
    // The fake ffmpeg runner emulates a successful encode by writing the
    // expected output file in place, so the subsequent stat()/readFile()
    // returns the bytes uploadClipObject pushes to storage.
    const runner = vi.fn(async (_cmd: string, args: readonly string[]) => {
      const outputPath = args[args.length - 1]!;
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, Buffer.from("ENCODED-CLIP-BYTES"));
      return { code: 0, stdout: "", stderr: "" };
    }) as unknown as Runner;

    const result = await extractAndUploadLessonClip(
      asClient(storage),
      {
        householdId: HOUSEHOLD,
        lessonId: LESSON,
        source: buildSource(),
        range: { id: "clip-7", startMs: 12_340, endMs: 16_780 },
        kind: "dialogue",
      },
      { ffmpegPath: "/fake/ffmpeg", runner },
    );

    expect(result.bucket).toBe("lesson-clips");
    expect(result.storagePath).toBe(`${HOUSEHOLD}/${LESSON}/clips/dialogues/clip-7.mp3`);
    expect(result.durationMs).toBe(4_440);
    expect(result.byteSize).toBe(Buffer.from("ENCODED-CLIP-BYTES").length);

    expect(storage.uploads).toHaveLength(1);
    const upload = storage.uploads[0]!;
    expect(upload.bucket).toBe("lesson-clips");
    expect(upload.path).toBe(`${HOUSEHOLD}/${LESSON}/clips/dialogues/clip-7.mp3`);
    expect(upload.upsert).toBe(true);
    expect(upload.contentType).toBe("audio/mpeg");
    expect(upload.bytes.toString("utf8")).toBe("ENCODED-CLIP-BYTES");
  });

  it("derives the same storage path on a repeat call with the same inputs (idempotency)", async () => {
    const storage = new FakeStorage(Buffer.from("FAKE"));
    const runner = vi.fn(async (_cmd: string, args: readonly string[]) => {
      const outputPath = args[args.length - 1]!;
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, Buffer.from("BYTES"));
      return { code: 0, stdout: "", stderr: "" };
    }) as unknown as Runner;

    const args = {
      householdId: HOUSEHOLD,
      lessonId: LESSON,
      source: buildSource(),
      range: { startMs: 1_000, endMs: 4_000 },
      kind: "shadowing" as const,
    };

    const a = await extractAndUploadLessonClip(asClient(storage), args, {
      ffmpegPath: "/fake/ffmpeg",
      runner,
    });
    const b = await extractAndUploadLessonClip(asClient(storage), args, {
      ffmpegPath: "/fake/ffmpeg",
      runner,
    });
    expect(a.storagePath).toBe(b.storagePath);
    expect(a.storagePath).toBe(`${HOUSEHOLD}/${LESSON}/clips/shadowing/1000-4000.mp3`);
    // Idempotent uploads — both calls land on the same path with upsert: true,
    // matching the acceptance criterion's "deterministic and idempotent".
    expect(storage.uploads).toHaveLength(2);
    expect(storage.uploads[0]!.path).toBe(storage.uploads[1]!.path);
    expect(storage.uploads.every((u) => u.upsert === true)).toBe(true);
  });

  it("can extract without re-downloading when the local source is already on disk", async () => {
    const storage = new FakeStorage(Buffer.from("FAKE"));
    const runner = vi.fn(async (_cmd: string, args: readonly string[]) => {
      const outputPath = args[args.length - 1]!;
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, Buffer.from("BYTES"));
      return { code: 0, stdout: "", stderr: "" };
    }) as unknown as Runner;

    // Pre-seed a local file the helper will read.
    const tmpDir = await import("node:os").then((m) => m.tmpdir());
    const localPath = path.join(tmpDir, `vol113-source-${Date.now()}.mp3`);
    await writeFile(localPath, Buffer.from("LOCAL-AUDIO"));

    const out = await extractClipFromLocalSource(
      asClient(storage),
      {
        householdId: HOUSEHOLD,
        lessonId: LESSON,
        localSourcePath: localPath,
        range: { startMs: 0, endMs: 500 },
        kind: "vocab",
      },
      { ffmpegPath: "/fake/ffmpeg", runner },
    );

    expect(out.storagePath).toBe(`${HOUSEHOLD}/${LESSON}/clips/vocab/0-500.mp3`);
    expect(storage.downloads).toEqual([]);
  });
});

describe("maybeTrimSilenceForLessonAudio", () => {
  it("is a no-op when MEDIA_SILENCE_TRIM_ENABLED is unset (the documented follow-up)", async () => {
    const storage = new FakeStorage(Buffer.from("FAKE"));
    const runner: Runner = vi.fn();

    const result = await maybeTrimSilenceForLessonAudio(
      asClient(storage),
      {
        householdId: HOUSEHOLD,
        lessonId: LESSON,
        source: buildSource(),
      },
      { env: {}, tools: { ffmpegPath: "/fake/ffmpeg", runner } },
    );

    expect(result).toBeNull();
    expect(storage.downloads).toEqual([]);
    expect(storage.uploads).toEqual([]);
    expect(runner).not.toHaveBeenCalled();
  });

  it("runs the silenceremove filter and uploads the trimmed copy when the flag is on", async () => {
    const storage = new FakeStorage(Buffer.from("FAKE"));
    let observedFilter: string | null = null;
    const runner = vi.fn(async (_cmd: string, args: readonly string[]) => {
      const outputPath = args[args.length - 1]!;
      const filterIdx = args.indexOf("-af");
      if (filterIdx !== -1) observedFilter = args[filterIdx + 1] ?? null;
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, Buffer.from("TRIMMED"));
      return { code: 0, stdout: "", stderr: "" };
    }) as unknown as Runner;

    const result = await maybeTrimSilenceForLessonAudio(
      asClient(storage),
      { householdId: HOUSEHOLD, lessonId: LESSON, source: buildSource() },
      {
        env: { MEDIA_SILENCE_TRIM_ENABLED: "true" },
        tools: { ffmpegPath: "/fake/ffmpeg", runner },
      },
    );

    expect(result).toEqual({
      bucket: "lesson-clips",
      storagePath: `${HOUSEHOLD}/${LESSON}/source.trimmed.mp3`,
    });
    expect(observedFilter).toBe(
      "silenceremove=stop_periods=-1:stop_duration=5.000:stop_threshold=-40dB",
    );
    expect(storage.uploads).toHaveLength(1);
    expect(storage.uploads[0]!.path).toBe(`${HOUSEHOLD}/${LESSON}/source.trimmed.mp3`);
  });
});
