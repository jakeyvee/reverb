// Static binary discovery for ffmpeg + ffprobe.
//
// We default to the `ffmpeg-static` / `ffprobe-static` packages which ship
// prebuilt binaries for every platform the project runs on (developer macOS,
// the Linux containers Trigger.dev executes tasks in). That keeps the worker
// zero-ops: no system package install, no Docker layer, no host ffmpeg.
//
// Env overrides let an operator point at the system ffmpeg if the static
// package is unusable on a particular platform (or for local dev where
// `ffmpeg-static` can fail to download during install). Tests inject paths
// directly via the options bag rather than going through env.

let cachedFfmpeg: string | null | undefined;
let cachedFfprobe: string | null | undefined;

export function resetBinaryCacheForTests(): void {
  cachedFfmpeg = undefined;
  cachedFfprobe = undefined;
}

export async function resolveFfmpegPath(): Promise<string | null> {
  if (cachedFfmpeg !== undefined) return cachedFfmpeg;
  const fromEnv = process.env.MEDIA_FFMPEG_PATH?.trim();
  if (fromEnv) {
    cachedFfmpeg = fromEnv;
    return cachedFfmpeg;
  }
  try {
    const mod: unknown = await import("ffmpeg-static");
    cachedFfmpeg = extractStringExport(mod);
  } catch {
    cachedFfmpeg = null;
  }
  return cachedFfmpeg;
}

export async function resolveFfprobePath(): Promise<string | null> {
  if (cachedFfprobe !== undefined) return cachedFfprobe;
  const fromEnv = process.env.MEDIA_FFPROBE_PATH?.trim();
  if (fromEnv) {
    cachedFfprobe = fromEnv;
    return cachedFfprobe;
  }
  try {
    const mod: unknown = await import("ffprobe-static");
    cachedFfprobe = extractPathExport(mod);
  } catch {
    cachedFfprobe = null;
  }
  return cachedFfprobe;
}

function extractStringExport(mod: unknown): string | null {
  if (typeof mod === "string") return mod;
  if (mod && typeof mod === "object") {
    const def = (mod as { default?: unknown }).default;
    if (typeof def === "string") return def;
  }
  return null;
}

function extractPathExport(mod: unknown): string | null {
  if (mod && typeof mod === "object") {
    const direct = (mod as { path?: unknown }).path;
    if (typeof direct === "string") return direct;
    const def = (mod as { default?: { path?: unknown } }).default;
    if (def && typeof def.path === "string") return def.path;
  }
  return null;
}
