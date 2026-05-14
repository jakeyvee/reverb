import { z } from "zod";

export const MAX_LESSON_AUDIO_BYTES = 200 * 1024 * 1024;
export const MAX_LESSON_AUDIO_DURATION_MS = 90 * 60 * 1000;

export const LESSON_AUDIO_BUCKET = "lesson-audio" as const;

// Browsers report different mime aliases for the same audio container, so the
// allow-list accepts every alias we've seen for mp3/m4a/wav/webm. The first
// entry per extension is the canonical type we persist on lesson_files.
const MIME_BY_EXTENSION = {
  mp3: ["audio/mpeg", "audio/mp3"],
  m4a: ["audio/mp4", "audio/x-m4a"],
  wav: ["audio/wav", "audio/x-wav", "audio/wave"],
  webm: ["audio/webm"],
} as const;

export type LessonAudioExtension = keyof typeof MIME_BY_EXTENSION;

export const LESSON_AUDIO_EXTENSIONS = Object.keys(MIME_BY_EXTENSION) as LessonAudioExtension[];

export const LESSON_AUDIO_MIME_TYPES: readonly string[] = Object.values(MIME_BY_EXTENSION).flat();

export function extensionForMimeType(mimeType: string): LessonAudioExtension | null {
  const target = mimeType.trim().toLowerCase();
  if (!target) return null;
  for (const ext of LESSON_AUDIO_EXTENSIONS) {
    const aliases = MIME_BY_EXTENSION[ext] as readonly string[];
    if (aliases.includes(target)) return ext;
  }
  return null;
}

export function extensionFromFileName(fileName: string): LessonAudioExtension | null {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return null;
  const ext = fileName.slice(dot + 1).toLowerCase();
  return (LESSON_AUDIO_EXTENSIONS as readonly string[]).includes(ext)
    ? (ext as LessonAudioExtension)
    : null;
}

export function canonicalMimeForExtension(ext: LessonAudioExtension): string {
  return MIME_BY_EXTENSION[ext][0];
}

export function isLessonAudioMimeType(mimeType: string): boolean {
  return extensionForMimeType(mimeType) !== null;
}

export const LessonUploadIntentInputSchema = z.object({
  fileName: z.string().min(1).max(255),
  mimeType: z
    .string()
    .min(1)
    .max(120)
    .refine(isLessonAudioMimeType, { message: "Unsupported audio type" }),
  byteSize: z.number().int().positive().max(MAX_LESSON_AUDIO_BYTES, {
    message: `File exceeds the ${Math.round(MAX_LESSON_AUDIO_BYTES / (1024 * 1024))} MB limit`,
  }),
  durationMs: z.number().int().positive().max(MAX_LESSON_AUDIO_DURATION_MS, {
    message: `Audio exceeds the ${Math.round(MAX_LESSON_AUDIO_DURATION_MS / 60_000)}-minute limit`,
  }),
});
export type LessonUploadIntentInput = z.infer<typeof LessonUploadIntentInputSchema>;

export const LessonUploadFinalizeInputSchema = LessonUploadIntentInputSchema.extend({
  lessonId: z.string().uuid(),
  storagePath: z.string().min(1).max(500),
  title: z.string().trim().min(1).max(160),
});
export type LessonUploadFinalizeInput = z.infer<typeof LessonUploadFinalizeInputSchema>;
