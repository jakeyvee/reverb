import { resolveFfmpegPath } from "./bin.js";
import { MediaProcessError, defaultRunner, type Runner } from "./exec.js";

export type ExtractAudioClipInput = {
  inputPath: string;
  outputPath: string;
  // Inclusive clip window, in milliseconds. The function validates that end
  // is strictly after start; sub-second ranges are allowed.
  startMs: number;
  endMs: number;
  // mp3 (libmp3lame) is the default because every browser plays it and the
  // bitrate keeps storage cost low for short review clips. Callers that need
  // a different container (e.g. WAV for re-processing) can pass `codec: "copy"`
  // when the input/output containers already match.
  codec?: "mp3" | "copy";
  bitrate?: string;
};

export type ExtractAudioClipResult = {
  outputPath: string;
  startMs: number;
  endMs: number;
  durationMs: number;
};

export type ExtractAudioClipOptions = {
  ffmpegPath?: string | null;
  runner?: Runner;
};

// Pulls the [startMs, endMs) range out of `inputPath` and writes it to
// `outputPath`. ffmpeg uses input-side seek (`-ss` before `-i`) for speed and
// then re-encodes the output so the cut is sample-accurate. For mp3 sources
// codec-copy would be 10–100x faster but rounds to the nearest frame header,
// which makes shadowing clips drift; correctness wins.
export async function extractAudioClip(
  input: ExtractAudioClipInput,
  opts: ExtractAudioClipOptions = {},
): Promise<ExtractAudioClipResult> {
  if (!Number.isFinite(input.startMs) || input.startMs < 0) {
    throw new Error(`extractAudioClip: invalid startMs ${input.startMs}`);
  }
  if (!Number.isFinite(input.endMs) || input.endMs <= input.startMs) {
    throw new Error(
      `extractAudioClip: endMs (${input.endMs}) must be > startMs (${input.startMs})`,
    );
  }
  const runner = opts.runner ?? defaultRunner;
  const binary = opts.ffmpegPath !== undefined ? opts.ffmpegPath : await resolveFfmpegPath();
  if (!binary) {
    throw new Error("ffmpeg binary not found. Install ffmpeg-static or set MEDIA_FFMPEG_PATH.");
  }

  const codec = input.codec ?? "mp3";
  const args = [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    // Input-side seek: ffmpeg skips frames before decoding, which is the
    // fastest accurate path for audio. -to here is interpreted relative to
    // the input timeline because it precedes -i.
    "-ss",
    formatSeconds(input.startMs),
    "-to",
    formatSeconds(input.endMs),
    "-i",
    input.inputPath,
    ...(codec === "copy"
      ? ["-c", "copy"]
      : ["-c:a", "libmp3lame", "-b:a", input.bitrate ?? "96k", "-ar", "44100"]),
    input.outputPath,
  ];
  const result = await runner(binary, args);
  if (result.code !== 0) {
    throw new MediaProcessError("ffmpeg", args, result);
  }
  return {
    outputPath: input.outputPath,
    startMs: input.startMs,
    endMs: input.endMs,
    durationMs: input.endMs - input.startMs,
  };
}

// ffmpeg accepts both H:MM:SS.mmm and a bare second value; we emit seconds
// with millisecond precision so the argv stays compact and stable in tests.
function formatSeconds(ms: number): string {
  const seconds = ms / 1000;
  // 3 decimal places mirrors ffmpeg's internal AV_TIME_BASE_Q resolution and
  // is enough for sample-accurate cuts at any sane sample rate.
  return seconds.toFixed(3);
}
