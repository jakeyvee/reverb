// Real-binary integration test. Skipped automatically when ffmpeg-static or
// ffprobe-static can't be resolved (e.g. CI ran with `--ignore-scripts` and
// the binaries were never downloaded). Run locally with:
//
//   pnpm --filter @reverb/media test integration
//
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { resolveFfmpegPath, resolveFfprobePath } from "../src/bin.js";
import { extractAudioClip } from "../src/clip.js";
import { probeDurationMs } from "../src/probe.js";

async function binariesAvailable(): Promise<boolean> {
  const [ffmpeg, ffprobe] = await Promise.all([resolveFfmpegPath(), resolveFfprobePath()]);
  if (!ffmpeg || !ffprobe) return false;
  try {
    await stat(ffmpeg);
    await stat(ffprobe);
    return true;
  } catch {
    return false;
  }
}

const haveBinaries = await binariesAvailable();
const maybeIt = haveBinaries ? it : it.skip;

describe("media integration (real ffmpeg/ffprobe)", () => {
  maybeIt(
    "synthesises a sine wave, probes it, and extracts a sub-clip",
    async () => {
      const ffmpegPath = await resolveFfmpegPath();
      const ffprobePath = await resolveFfprobePath();
      expect(ffmpegPath).toBeTruthy();
      expect(ffprobePath).toBeTruthy();

      const workDir = await mkdtemp(path.join(tmpdir(), "media-integ-"));
      try {
        const sourcePath = path.join(workDir, "sine.mp3");

        // Generate a 6-second mono 440Hz sine wave directly to mp3. ffmpeg's
        // `lavfi` virtual input avoids needing a checked-in audio fixture.
        await runRaw(ffmpegPath!, [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=6",
          "-c:a",
          "libmp3lame",
          "-b:a",
          "64k",
          sourcePath,
        ]);
        await writeFile(path.join(workDir, "marker.txt"), "ok");

        const durationMs = await probeDurationMs(sourcePath);
        // mp3 frame alignment lets the actual duration drift a tens of ms; the
        // assertion only needs to confirm we got back something plausible.
        expect(durationMs).toBeGreaterThanOrEqual(5_900);
        expect(durationMs).toBeLessThanOrEqual(6_200);

        const clipPath = path.join(workDir, "clip.mp3");
        const clip = await extractAudioClip({
          inputPath: sourcePath,
          outputPath: clipPath,
          startMs: 1_000,
          endMs: 3_000,
        });
        expect(clip.durationMs).toBe(2_000);
        const clipStats = await stat(clipPath);
        expect(clipStats.size).toBeGreaterThan(0);

        const clipDurationMs = await probeDurationMs(clipPath);
        expect(clipDurationMs).toBeGreaterThanOrEqual(1_900);
        expect(clipDurationMs).toBeLessThanOrEqual(2_200);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});

function runRaw(cmd: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) reject(new Error(`${cmd} exited ${code}: ${stderr.trim()}`));
      else resolve();
    });
  });
}
