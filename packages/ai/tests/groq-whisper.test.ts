import { describe, expect, it } from "vitest";
import { SCHEMA_VERSIONS } from "@reverb/domain";
import {
  GROQ_WHISPER_MODEL,
  GROQ_WHISPER_PROVIDER_ID,
  GroqVerboseTranscriptionSchema,
  mapGroqVerboseToTranscript,
} from "../src/providers/groq-whisper.js";

// Captured-shape fixture mirroring Groq Whisper's verbose_json response for a
// short Bahasa Indonesia clip. Kept inline so the test is self-contained and
// does not depend on filesystem layout.
const fixture = {
  task: "transcribe",
  language: "indonesian",
  duration: 4.12,
  text: " Selamat pagi. Apa kabar hari ini?",
  segments: [
    {
      id: 0,
      start: 0.0,
      end: 1.8,
      text: " Selamat pagi.",
      avg_logprob: -0.2,
      no_speech_prob: 0.02,
    },
    {
      id: 1,
      start: 1.9,
      end: 4.12,
      text: " Apa kabar hari ini?",
      avg_logprob: -0.18,
      no_speech_prob: 0.01,
    },
  ],
  words: [
    { word: "Selamat", start: 0.05, end: 0.78 },
    { word: "pagi", start: 0.79, end: 1.7 },
    { word: "Apa", start: 1.9, end: 2.2 },
    { word: "kabar", start: 2.21, end: 2.8 },
    { word: "hari", start: 2.85, end: 3.3 },
    { word: "ini", start: 3.31, end: 4.0 },
  ],
};

describe("GroqVerboseTranscriptionSchema", () => {
  it("accepts the fixture payload", () => {
    const parsed = GroqVerboseTranscriptionSchema.parse(fixture);
    expect(parsed.segments).toHaveLength(2);
    expect(parsed.words).toHaveLength(6);
  });

  it("accepts a minimal response with only text (verbose_json fallback)", () => {
    const parsed = GroqVerboseTranscriptionSchema.parse({ text: "halo" });
    expect(parsed.text).toBe("halo");
    expect(parsed.segments).toBeUndefined();
  });
});

describe("mapGroqVerboseToTranscript", () => {
  const baseOpts = {
    sourceId: "lesson-42",
    language: "id",
    model: GROQ_WHISPER_MODEL,
    createdAt: "2026-05-15T00:00:00.000Z",
  } as const;

  it("normalizes a verbose Groq response into a domain Transcript", () => {
    const parsed = GroqVerboseTranscriptionSchema.parse(fixture);
    const transcript = mapGroqVerboseToTranscript(parsed, baseOpts);

    expect(transcript.schemaVersion).toBe(SCHEMA_VERSIONS.transcript);
    expect(transcript.provider).toBe(GROQ_WHISPER_PROVIDER_ID);
    expect(transcript.model).toBe(GROQ_WHISPER_MODEL);
    expect(transcript.sourceId).toBe("lesson-42");
    // Groq returns the language label ("indonesian"); the adapter preserves
    // whatever the provider sends so the audit field reflects truth.
    expect(transcript.language).toBe("indonesian");
    expect(transcript.durationSec).toBeCloseTo(4.12, 2);
    expect(transcript.segments).toHaveLength(2);
    expect(transcript.segments[0]?.text).toBe("Selamat pagi.");
    expect(transcript.segments[0]?.speaker).toBe("unknown");
    expect(transcript.segments[0]?.start).toBe(0);
    expect(transcript.segments[0]?.end).toBeCloseTo(1.8, 2);
  });

  it("buckets top-level words into the segment that brackets them", () => {
    const parsed = GroqVerboseTranscriptionSchema.parse(fixture);
    const transcript = mapGroqVerboseToTranscript(parsed, baseOpts);

    expect(transcript.segments[0]?.words?.map((w) => w.word)).toEqual(["Selamat", "pagi"]);
    expect(transcript.segments[1]?.words?.map((w) => w.word)).toEqual([
      "Apa",
      "kabar",
      "hari",
      "ini",
    ]);
  });

  it("falls back to nested words on each segment when present", () => {
    const nested = GroqVerboseTranscriptionSchema.parse({
      ...fixture,
      words: undefined,
      segments: [
        {
          id: 0,
          start: 0,
          end: 1.8,
          text: " Selamat pagi.",
          words: [
            { word: "Selamat", start: 0.05, end: 0.78 },
            { word: "pagi", start: 0.79, end: 1.7 },
          ],
        },
        {
          id: 1,
          start: 1.9,
          end: 4.12,
          text: " Apa kabar.",
        },
      ],
    });
    const transcript = mapGroqVerboseToTranscript(nested, baseOpts);

    expect(transcript.segments[0]?.words).toHaveLength(2);
    // Absence of word timestamps on the second segment is allowed — the
    // domain schema makes `words` optional and the adapter omits it.
    expect(transcript.segments[1]?.words).toBeUndefined();
  });

  it("handles a response with no segments and no words", () => {
    const empty = GroqVerboseTranscriptionSchema.parse({ text: "" });
    const transcript = mapGroqVerboseToTranscript(empty, baseOpts);

    expect(transcript.segments).toHaveLength(0);
    expect(transcript.durationSec).toBe(0);
    expect(transcript.language).toBe("id");
  });

  it("clamps word end timestamps to start when the provider returns inverted bounds", () => {
    // Whisper occasionally emits end < start by a hair on the last token of a
    // burst. The domain schema would reject those, so the adapter clamps.
    const tricky = GroqVerboseTranscriptionSchema.parse({
      ...fixture,
      segments: [
        {
          id: 0,
          start: 0,
          end: 1.8,
          text: "Selamat pagi.",
          words: [{ word: "pagi", start: 1.6, end: 1.5 }],
        },
      ],
      words: undefined,
    });
    const transcript = mapGroqVerboseToTranscript(tricky, baseOpts);
    expect(transcript.segments[0]?.words?.[0]?.end).toBe(1.6);
  });
});
