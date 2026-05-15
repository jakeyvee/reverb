import { resolveFfmpegPath } from "./bin.js";
import { MediaProcessError, defaultRunner, type Runner } from "./exec.js";

export type TrimLongSilencesInput = {
  inputPath: string;
  outputPath: string;
  // Only silences longer than this threshold get removed. The PRD calls out
  // 5 seconds as the minimum — anything shorter is conversational pause and
  // removing it would mangle dialogue cadence. Default mirrors the PRD.
  minSilenceMs?: number;
  // ffmpeg `silenceremove` uses absolute amplitude levels in dB. -40 dBFS is
  // a conservative threshold for speech recordings: below this is typically
  // hum or room tone, not voice. Tunable per call for robustness on noisier
  // sources.
  thresholdDb?: number;
  // mp3 re-encode for output; passthrough is unsafe because the silenceremove
  // filter rewrites the frame timing.
  bitrate?: string;
};

export type TrimLongSilencesResult = {
  outputPath: string;
  filter: string;
};

export type TrimLongSilencesOptions = {
  ffmpegPath?: string | null;
  runner?: Runner;
};

// Removes silences of `minSilenceMs` or longer from `inputPath`, writing the
// result to `outputPath` as mp3. We use `silenceremove` with `stop_periods=-1`
// so every silence in the timeline is trimmed, not just leading silences.
//
// ## Why this is feature-flagged
//
// `silenceremove` is brittle on lossy inputs: low-bitrate mp3 / m4a encoders
// inject codec noise at quiet moments which slips above the silence threshold,
// and conservative thresholds leave some pauses intact. It's also unsafe to
// run before transcription because the timeline shifts, which breaks any
// downstream code that maps transcript ranges back to the original audio.
//
// Callers should:
//   * gate calls behind `MEDIA_SILENCE_TRIM_ENABLED`;
//   * preserve the original lesson file as the canonical source for clip
//     extraction (extractAudioClip operates on the original, not the trimmed
//     copy), so timestamps stay valid no matter what trimming does;
//   * treat the trimmed file as a cost-optimisation artefact only, e.g. the
//     input fed to expensive transcription providers.
//
// Follow-up: if the silence threshold proves unreliable on Vincent's
// recordings, drop in a VAD-based detector (e.g. webrtcvad bundled wasm) in a
// follow-up issue and keep the public API stable.
export async function trimLongSilences(
  input: TrimLongSilencesInput,
  opts: TrimLongSilencesOptions = {},
): Promise<TrimLongSilencesResult> {
  const runner = opts.runner ?? defaultRunner;
  const binary = opts.ffmpegPath !== undefined ? opts.ffmpegPath : await resolveFfmpegPath();
  if (!binary) {
    throw new Error("ffmpeg binary not found. Install ffmpeg-static or set MEDIA_FFMPEG_PATH.");
  }
  const minSilenceMs = input.minSilenceMs ?? 5_000;
  if (!Number.isFinite(minSilenceMs) || minSilenceMs <= 0) {
    throw new Error(`trimLongSilences: invalid minSilenceMs ${minSilenceMs}`);
  }
  const thresholdDb = input.thresholdDb ?? -40;

  const filter = [
    "silenceremove=stop_periods=-1",
    `stop_duration=${(minSilenceMs / 1000).toFixed(3)}`,
    `stop_threshold=${thresholdDb}dB`,
  ].join(":");

  const args = [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    input.inputPath,
    "-af",
    filter,
    "-c:a",
    "libmp3lame",
    "-b:a",
    input.bitrate ?? "96k",
    "-ar",
    "44100",
    input.outputPath,
  ];
  const result = await runner(binary, args);
  if (result.code !== 0) {
    throw new MediaProcessError("ffmpeg", args, result);
  }
  return { outputPath: input.outputPath, filter };
}

// Returns true if the operator has explicitly opted into silence trimming for
// this deployment. We default to off because of the brittleness called out
// above — flipping the flag is the documented "I've validated this on our
// content" gate.
export function isSilenceTrimEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.MEDIA_SILENCE_TRIM_ENABLED;
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}
