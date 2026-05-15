import { describe, expect, it, vi } from "vitest";
import { extractAudioClip } from "../src/clip.js";
import { MediaProcessError, type Runner } from "../src/exec.js";

const fakeBinary = "/fake/ffmpeg";

describe("extractAudioClip", () => {
  it("builds the expected mp3 re-encode command and reports the extracted range", async () => {
    const fakeRunner: Runner = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    const result = await extractAudioClip(
      {
        inputPath: "/tmp/source.mp3",
        outputPath: "/tmp/out.mp3",
        startMs: 12_340,
        endMs: 16_780,
      },
      { ffmpegPath: fakeBinary, runner: fakeRunner },
    );

    expect(result).toEqual({
      outputPath: "/tmp/out.mp3",
      startMs: 12_340,
      endMs: 16_780,
      durationMs: 4_440,
    });

    const [cmd, args] = (fakeRunner as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(cmd).toBe(fakeBinary);
    expect(args).toEqual([
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      "12.340",
      "-to",
      "16.780",
      "-i",
      "/tmp/source.mp3",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "96k",
      "-ar",
      "44100",
      "/tmp/out.mp3",
    ]);
  });

  it("honors codec: copy when the caller asks for stream copy", async () => {
    const fakeRunner: Runner = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    await extractAudioClip(
      {
        inputPath: "/tmp/source.mp3",
        outputPath: "/tmp/out.mp3",
        startMs: 0,
        endMs: 1_000,
        codec: "copy",
      },
      { ffmpegPath: fakeBinary, runner: fakeRunner },
    );
    const [, args] = (fakeRunner as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(args).toContain("-c");
    expect(args).toContain("copy");
    expect(args).not.toContain("libmp3lame");
  });

  it("rejects an empty or inverted clip window before invoking ffmpeg", async () => {
    const fakeRunner: Runner = vi.fn();
    await expect(
      extractAudioClip(
        { inputPath: "/a", outputPath: "/b", startMs: 1_000, endMs: 1_000 },
        { ffmpegPath: fakeBinary, runner: fakeRunner },
      ),
    ).rejects.toThrow(/endMs.*must be > startMs/);
    await expect(
      extractAudioClip(
        { inputPath: "/a", outputPath: "/b", startMs: 2_000, endMs: 1_000 },
        { ffmpegPath: fakeBinary, runner: fakeRunner },
      ),
    ).rejects.toThrow(/endMs.*must be > startMs/);
    await expect(
      extractAudioClip(
        { inputPath: "/a", outputPath: "/b", startMs: -1, endMs: 1_000 },
        { ffmpegPath: fakeBinary, runner: fakeRunner },
      ),
    ).rejects.toThrow(/invalid startMs/);
    expect(fakeRunner).not.toHaveBeenCalled();
  });

  it("surfaces ffmpeg failures as MediaProcessError", async () => {
    const fakeRunner: Runner = vi
      .fn()
      .mockResolvedValue({ code: 1, stdout: "", stderr: "encoder error" });
    await expect(
      extractAudioClip(
        { inputPath: "/a", outputPath: "/b", startMs: 0, endMs: 1_000 },
        { ffmpegPath: fakeBinary, runner: fakeRunner },
      ),
    ).rejects.toBeInstanceOf(MediaProcessError);
  });

  it("throws a clear message when no ffmpeg binary is available", async () => {
    const fakeRunner: Runner = vi.fn();
    await expect(
      extractAudioClip(
        { inputPath: "/a", outputPath: "/b", startMs: 0, endMs: 1_000 },
        { ffmpegPath: null, runner: fakeRunner },
      ),
    ).rejects.toThrow(/ffmpeg binary not found/);
  });
});
