import { resolveFfprobePath } from "./bin.js";
import { MediaProcessError, defaultRunner, type Runner } from "./exec.js";

export type ProbeOptions = {
  ffprobePath?: string | null;
  runner?: Runner;
};

// Returns the audio duration of `inputPath` in milliseconds. Used by the
// worker as part of acceptance-criteria 1 ("worker can verify actual duration
// of uploaded audio") — the upload action persists a client-reported duration,
// and downstream stages cross-check it against the actual decoded duration to
// catch corrupted or truncated uploads early.
export async function probeDurationMs(inputPath: string, opts: ProbeOptions = {}): Promise<number> {
  const runner = opts.runner ?? defaultRunner;
  // `ffprobePath: null` is treated as "explicitly no binary" so a test can
  // exercise the missing-binary branch even when the static package is
  // installed in node_modules.
  const binary = opts.ffprobePath !== undefined ? opts.ffprobePath : await resolveFfprobePath();
  if (!binary) {
    throw new Error("ffprobe binary not found. Install ffprobe-static or set MEDIA_FFPROBE_PATH.");
  }
  const args = [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=nokey=1:noprint_wrappers=1",
    inputPath,
  ];
  const result = await runner(binary, args);
  if (result.code !== 0) {
    throw new MediaProcessError("ffprobe", args, result);
  }
  const seconds = parseFloat(result.stdout.trim());
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`ffprobe returned an invalid duration: "${result.stdout.trim()}"`);
  }
  return Math.round(seconds * 1000);
}
