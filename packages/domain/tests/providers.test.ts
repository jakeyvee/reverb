import { describe, expect, it } from "vitest";
import {
  AsrProviderRequestSchema,
  AsrProviderResponseSchema,
  ExtractionProviderRequestSchema,
  ExtractionProviderResponseSchema,
  TtsProviderRequestSchema,
  TtsProviderResponseSchema,
} from "../src/schemas/providers.js";
import { SCHEMA_VERSIONS } from "../src/versions.js";

const transcript = {
  schemaVersion: SCHEMA_VERSIONS.transcript,
  sourceId: "lesson-1",
  language: "ko",
  durationSec: 90,
  provider: "groq-whisper",
  model: "whisper-large-v3",
  createdAt: "2026-05-14T10:00:00.000Z",
  segments: [
    {
      id: "seg-1",
      speaker: "teacher" as const,
      text: "안녕하세요",
      start: 0,
      end: 1.5,
    },
  ],
};

describe("AsrProvider contracts", () => {
  it("accepts a valid ASR request", () => {
    const result = AsrProviderRequestSchema.safeParse({
      audioUrl: "https://cdn.reverb.dev/audio/lesson-1.mp3",
      language: "ko",
      diarize: true,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an ASR request with a non-URL audio", () => {
    const result = AsrProviderRequestSchema.safeParse({ audioUrl: "not a url" });
    expect(result.success).toBe(false);
  });

  it("validates ASR response as a transcript", () => {
    expect(AsrProviderResponseSchema.safeParse(transcript).success).toBe(true);
  });
});

describe("ExtractionProvider contracts", () => {
  it("defaults studentSpeakers when omitted", () => {
    const parsed = ExtractionProviderRequestSchema.parse({
      transcript,
      promptVersion: "extract-v1",
      targetLanguage: "ko",
    });
    expect(parsed.studentSpeakers).toEqual(["student_vincent", "student_gf"]);
  });

  it("rejects an extraction response with bad schemaVersion", () => {
    const result = ExtractionProviderResponseSchema.safeParse({
      schemaVersion: 0,
      promptVersion: "extract-v1",
      language: "ko",
      sourceTranscriptId: "tr-1",
      new_vocab: [],
      grammar_patterns: [],
      dialogue_clips: [],
      teacher_corrections: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("TtsProvider contracts", () => {
  it("accepts a valid TTS request", () => {
    expect(
      TtsProviderRequestSchema.safeParse({ text: "안녕", language: "ko" }).success,
    ).toBe(true);
  });

  it("rejects a TTS request with empty text", () => {
    expect(TtsProviderRequestSchema.safeParse({ text: "", language: "ko" }).success).toBe(
      false,
    );
  });

  it("validates a TTS response", () => {
    const result = TtsProviderResponseSchema.safeParse({
      audioUrl: "https://cdn.reverb.dev/tts/abc.mp3",
      mimeType: "audio/mpeg",
      durationSec: 1.2,
      provider: "google",
    });
    expect(result.success).toBe(true);
  });
});
