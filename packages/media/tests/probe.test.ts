import { describe, expect, it, vi } from "vitest";
import { probeDurationMs } from "../src/probe.js";
import { MediaProcessError, type Runner } from "../src/exec.js";

const fakeBinary = "/fake/ffprobe";

describe("probeDurationMs", () => {
  it("returns the duration in milliseconds rounded to the nearest ms", async () => {
    const fakeRunner: Runner = vi.fn().mockResolvedValue({
      code: 0,
      stdout: "12.3456\n",
      stderr: "",
    });

    const result = await probeDurationMs("/tmp/source.mp3", {
      ffprobePath: fakeBinary,
      runner: fakeRunner,
    });

    expect(result).toBe(12_346);
    expect(fakeRunner).toHaveBeenCalledTimes(1);
    const [cmd, args] = (fakeRunner as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(cmd).toBe(fakeBinary);
    // The argv must request format=duration in a script-friendly format so
    // we don't have to parse ffprobe's default human output.
    expect(args).toEqual([
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nokey=1:noprint_wrappers=1",
      "/tmp/source.mp3",
    ]);
  });

  it("throws MediaProcessError when ffprobe exits non-zero", async () => {
    const fakeRunner: Runner = vi.fn().mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "moov atom not found",
    });
    await expect(
      probeDurationMs("/tmp/broken.mp3", { ffprobePath: fakeBinary, runner: fakeRunner }),
    ).rejects.toBeInstanceOf(MediaProcessError);
  });

  it("rejects an unparseable duration", async () => {
    const fakeRunner: Runner = vi.fn().mockResolvedValue({ code: 0, stdout: "N/A\n", stderr: "" });
    await expect(
      probeDurationMs("/tmp/source.mp3", { ffprobePath: fakeBinary, runner: fakeRunner }),
    ).rejects.toThrow(/invalid duration/);
  });

  it("throws when ffprobe binary cannot be resolved", async () => {
    const fakeRunner: Runner = vi.fn();
    await expect(
      probeDurationMs("/tmp/x.mp3", { ffprobePath: null, runner: fakeRunner }),
    ).rejects.toThrow(/ffprobe binary not found/);
  });
});
