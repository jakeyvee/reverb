import { describe, expect, it } from "vitest";
import {
  LESSON_AUDIO_EXTENSIONS,
  LESSON_AUDIO_MIME_TYPES,
  LessonUploadFinalizeInputSchema,
  LessonUploadIntentInputSchema,
  MAX_LESSON_AUDIO_BYTES,
  MAX_LESSON_AUDIO_DURATION_MS,
  canonicalMimeForExtension,
  extensionForMimeType,
  extensionFromFileName,
  isLessonAudioMimeType,
} from "../src/schemas/upload.js";

const validIntent = {
  fileName: "voice-memo.m4a",
  mimeType: "audio/mp4",
  byteSize: 5 * 1024 * 1024,
  durationMs: 8 * 60 * 1000,
};

const validFinalize = {
  ...validIntent,
  lessonId: "11111111-2222-4333-8444-555555555555",
  storagePath: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/11111111-2222-4333-8444-555555555555/source.m4a",
  title: "Lesson with teacher",
};

describe("upload constants", () => {
  it("caps payloads at 200 MB and 90 minutes", () => {
    expect(MAX_LESSON_AUDIO_BYTES).toBe(200 * 1024 * 1024);
    expect(MAX_LESSON_AUDIO_DURATION_MS).toBe(90 * 60 * 1000);
  });

  it("lists exactly mp3, m4a, wav, webm", () => {
    expect([...LESSON_AUDIO_EXTENSIONS].sort()).toEqual(["m4a", "mp3", "wav", "webm"]);
  });

  it("includes every alias mime type in the allow-list", () => {
    expect(LESSON_AUDIO_MIME_TYPES).toContain("audio/mpeg");
    expect(LESSON_AUDIO_MIME_TYPES).toContain("audio/mp4");
    expect(LESSON_AUDIO_MIME_TYPES).toContain("audio/x-m4a");
    expect(LESSON_AUDIO_MIME_TYPES).toContain("audio/wav");
    expect(LESSON_AUDIO_MIME_TYPES).toContain("audio/webm");
  });
});

describe("mime/extension helpers", () => {
  it("maps known mime aliases back to their extension", () => {
    expect(extensionForMimeType("audio/mpeg")).toBe("mp3");
    expect(extensionForMimeType("AUDIO/MP4")).toBe("m4a");
    expect(extensionForMimeType("audio/x-wav")).toBe("wav");
    expect(extensionForMimeType("audio/webm")).toBe("webm");
  });

  it("returns null for unknown mime types", () => {
    expect(extensionForMimeType("video/mp4")).toBeNull();
    expect(extensionForMimeType("")).toBeNull();
  });

  it("infers extension from a filename, ignoring case", () => {
    expect(extensionFromFileName("lesson.MP3")).toBe("mp3");
    expect(extensionFromFileName("name.with.dots.webm")).toBe("webm");
    expect(extensionFromFileName("noext")).toBeNull();
    expect(extensionFromFileName(".trailing.")).toBeNull();
  });

  it("returns a canonical mime per extension", () => {
    expect(canonicalMimeForExtension("mp3")).toBe("audio/mpeg");
    expect(canonicalMimeForExtension("m4a")).toBe("audio/mp4");
    expect(canonicalMimeForExtension("wav")).toBe("audio/wav");
    expect(canonicalMimeForExtension("webm")).toBe("audio/webm");
  });

  it("rejects everything not on the allow-list via isLessonAudioMimeType", () => {
    expect(isLessonAudioMimeType("audio/mpeg")).toBe(true);
    expect(isLessonAudioMimeType("audio/ogg")).toBe(false);
  });
});

describe("LessonUploadIntentInputSchema", () => {
  it("accepts a valid intent", () => {
    expect(LessonUploadIntentInputSchema.parse(validIntent)).toEqual(validIntent);
  });

  it("rejects oversized files", () => {
    const result = LessonUploadIntentInputSchema.safeParse({
      ...validIntent,
      byteSize: MAX_LESSON_AUDIO_BYTES + 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects audio longer than the duration limit", () => {
    const result = LessonUploadIntentInputSchema.safeParse({
      ...validIntent,
      durationMs: MAX_LESSON_AUDIO_DURATION_MS + 1,
    });
    expect(result.success).toBe(false);
  });

  it("rejects unsupported mime types", () => {
    const result = LessonUploadIntentInputSchema.safeParse({
      ...validIntent,
      mimeType: "audio/ogg",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-positive size or duration", () => {
    expect(
      LessonUploadIntentInputSchema.safeParse({ ...validIntent, byteSize: 0 }).success,
    ).toBe(false);
    expect(
      LessonUploadIntentInputSchema.safeParse({ ...validIntent, durationMs: 0 }).success,
    ).toBe(false);
  });
});

describe("LessonUploadFinalizeInputSchema", () => {
  it("accepts a valid finalize payload", () => {
    const parsed = LessonUploadFinalizeInputSchema.parse(validFinalize);
    expect(parsed.lessonId).toBe(validFinalize.lessonId);
    expect(parsed.title).toBe(validFinalize.title);
  });

  it("trims and rejects blank titles", () => {
    expect(
      LessonUploadFinalizeInputSchema.safeParse({ ...validFinalize, title: "   " }).success,
    ).toBe(false);
  });

  it("requires a uuid lessonId", () => {
    const result = LessonUploadFinalizeInputSchema.safeParse({
      ...validFinalize,
      lessonId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });
});
