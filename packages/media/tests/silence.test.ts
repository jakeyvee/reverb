import { describe, expect, it, vi } from "vitest";
import { isSilenceTrimEnabled, trimLongSilences } from "../src/silence.js";
import { type Runner } from "../src/exec.js";

const fakeBinary = "/fake/ffmpeg";

describe("trimLongSilences", () => {
  it("builds a silenceremove filter that only trims ≥5s gaps by default", async () => {
    const fakeRunner: Runner = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    const result = await trimLongSilences(
      { inputPath: "/tmp/in.mp3", outputPath: "/tmp/out.mp3" },
      { ffmpegPath: fakeBinary, runner: fakeRunner },
    );

    expect(result.filter).toBe(
      "silenceremove=stop_periods=-1:stop_duration=5.000:stop_threshold=-40dB",
    );
    const [, args] = (fakeRunner as ReturnType<typeof vi.fn>).mock.calls[0]!;
    // The filter string must round-trip through `-af` verbatim and the
    // output must be re-encoded to mp3 because the filter rewrites timing.
    expect(args).toContain("-af");
    const filterIdx = args.indexOf("-af");
    expect(args[filterIdx + 1]).toBe(result.filter);
    expect(args).toContain("libmp3lame");
  });

  it("honors a custom min silence duration and threshold", async () => {
    const fakeRunner: Runner = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const result = await trimLongSilences(
      {
        inputPath: "/a",
        outputPath: "/b",
        minSilenceMs: 7_500,
        thresholdDb: -35,
      },
      { ffmpegPath: fakeBinary, runner: fakeRunner },
    );
    expect(result.filter).toBe(
      "silenceremove=stop_periods=-1:stop_duration=7.500:stop_threshold=-35dB",
    );
  });

  it("rejects non-positive minimum silence durations", async () => {
    const fakeRunner: Runner = vi.fn();
    await expect(
      trimLongSilences(
        { inputPath: "/a", outputPath: "/b", minSilenceMs: 0 },
        { ffmpegPath: fakeBinary, runner: fakeRunner },
      ),
    ).rejects.toThrow(/invalid minSilenceMs/);
    expect(fakeRunner).not.toHaveBeenCalled();
  });
});

describe("isSilenceTrimEnabled", () => {
  it("defaults to off so a fresh deployment doesn't silently mutate audio", () => {
    expect(isSilenceTrimEnabled({})).toBe(false);
    expect(isSilenceTrimEnabled({ MEDIA_SILENCE_TRIM_ENABLED: "" })).toBe(false);
    expect(isSilenceTrimEnabled({ MEDIA_SILENCE_TRIM_ENABLED: "false" })).toBe(false);
    expect(isSilenceTrimEnabled({ MEDIA_SILENCE_TRIM_ENABLED: "0" })).toBe(false);
  });

  it("accepts the obvious truthy strings", () => {
    for (const v of ["1", "true", "True", "YES", "on"]) {
      expect(isSilenceTrimEnabled({ MEDIA_SILENCE_TRIM_ENABLED: v })).toBe(true);
    }
  });
});
