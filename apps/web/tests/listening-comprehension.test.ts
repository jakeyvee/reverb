import { describe, expect, it } from "vitest";
import {
  ListeningItemMetadataSchema,
  ListeningPromptSchema,
  LISTENING_PROMPT_KINDS,
  assignListeningPrompts,
  buildListeningPrompt,
  gradeListeningTranscription,
  parseListeningPromptFromMetadata,
  type ListeningClipCandidate,
} from "@/lib/session/listening-comprehension";

const baseClip: ListeningClipCandidate = {
  clipId: "11111111-1111-1111-1111-111111111111",
  lessonId: "22222222-2222-2222-2222-222222222222",
  segmentId: "33333333-3333-3333-3333-333333333333",
  caption: "Selamat pagi, apa kabar?",
  translation: "Good morning, how are you?",
  speaker: "teacher",
  durationMs: 6_400,
  storageBucket: "lesson-clips",
  storagePath: "household/lesson/clip.mp3",
};

const otherClip: ListeningClipCandidate = {
  ...baseClip,
  clipId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  segmentId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  caption: "Saya ingin minum kopi.",
  translation: "I would like to drink coffee.",
  speaker: "student_vincent",
};

const thirdClip: ListeningClipCandidate = {
  ...baseClip,
  clipId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
  segmentId: "dddddddd-dddd-dddd-dddd-dddddddddddd",
  caption: "Terima kasih banyak.",
  translation: "Thank you very much.",
  speaker: "student_gf",
};

describe("buildListeningPrompt", () => {
  it("builds a transcription prompt from the caption", () => {
    const prompt = buildListeningPrompt({ kind: "transcription", clip: baseClip, pool: [] });
    expect(prompt).not.toBeNull();
    expect(prompt!.kind).toBe("transcription");
    expect(prompt!.expectedText).toBe(baseClip.caption);
    expect(prompt!.choices).toEqual([]);
    expect(prompt!.answerIndex).toBeNull();
  });

  it("returns null for transcription when the clip has no caption", () => {
    const prompt = buildListeningPrompt({
      kind: "transcription",
      clip: { ...baseClip, caption: null },
      pool: [],
    });
    expect(prompt).toBeNull();
  });

  it("builds a multiple choice English prompt with the real answer + distractors", () => {
    const prompt = buildListeningPrompt({
      kind: "mc_english",
      clip: baseClip,
      pool: [baseClip, otherClip, thirdClip],
    });
    expect(prompt).not.toBeNull();
    expect(prompt!.kind).toBe("mc_english");
    expect(prompt!.choices).toHaveLength(3);
    expect(prompt!.choices).toContain(baseClip.translation);
    expect(prompt!.choices[prompt!.answerIndex!]).toBe(baseClip.translation);
    // Choices are deterministic for a given clipId.
    const second = buildListeningPrompt({
      kind: "mc_english",
      clip: baseClip,
      pool: [baseClip, otherClip, thirdClip],
    });
    expect(second!.choices).toEqual(prompt!.choices);
  });

  it("falls back to generic distractors when the pool has no other translations", () => {
    const prompt = buildListeningPrompt({
      kind: "mc_english",
      clip: baseClip,
      pool: [baseClip],
    });
    expect(prompt).not.toBeNull();
    expect(prompt!.choices.length).toBeGreaterThanOrEqual(3);
    expect(prompt!.choices).toContain(baseClip.translation);
  });

  it("returns null for mc_english when the clip lacks a translation", () => {
    const prompt = buildListeningPrompt({
      kind: "mc_english",
      clip: { ...baseClip, translation: null },
      pool: [otherClip, thirdClip],
    });
    expect(prompt).toBeNull();
  });

  it("builds a speaker_id prompt with the canonical speaker choices", () => {
    const prompt = buildListeningPrompt({ kind: "speaker_id", clip: baseClip, pool: [] });
    expect(prompt).not.toBeNull();
    expect(prompt!.kind).toBe("speaker_id");
    expect(prompt!.choices).toEqual(
      expect.arrayContaining(["teacher", "student_vincent", "student_gf"]),
    );
    expect(prompt!.choices[prompt!.answerIndex!]).toBe(baseClip.speaker);
  });

  it("returns null for speaker_id when the speaker is unknown", () => {
    const prompt = buildListeningPrompt({
      kind: "speaker_id",
      clip: { ...baseClip, speaker: "unknown" },
      pool: [],
    });
    expect(prompt).toBeNull();
  });
});

describe("assignListeningPrompts", () => {
  it("rotates through prompt kinds across clips", () => {
    const result = assignListeningPrompts([baseClip, otherClip, thirdClip]);
    expect(result).toHaveLength(3);
    expect(result.map((entry) => entry.prompt.kind)).toEqual(LISTENING_PROMPT_KINDS);
  });

  it("respects the limit option", () => {
    const result = assignListeningPrompts([baseClip, otherClip, thirdClip], { limit: 2 });
    expect(result).toHaveLength(2);
  });

  it("falls back through the rotation when the primary kind is unavailable", () => {
    const captionless: ListeningClipCandidate = {
      ...baseClip,
      caption: null,
    };
    const result = assignListeningPrompts([captionless], {
      rotation: ["transcription", "mc_english", "speaker_id"],
      limit: 1,
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.prompt.kind).not.toBe("transcription");
  });

  it("skips clips that satisfy no prompt kind", () => {
    const unusable: ListeningClipCandidate = {
      ...baseClip,
      caption: null,
      translation: null,
      speaker: "unknown",
    };
    expect(assignListeningPrompts([unusable])).toEqual([]);
  });
});

describe("gradeListeningTranscription", () => {
  it("passes when the answers match after normalization", () => {
    expect(
      gradeListeningTranscription({
        expected: "Selamat pagi, apa kabar?",
        actual: "selamat pagi apa kabar",
      }),
    ).toBe("pass");
  });

  it("fails when the user types something different", () => {
    expect(
      gradeListeningTranscription({
        expected: "Selamat pagi.",
        actual: "Terima kasih.",
      }),
    ).toBe("fail");
  });
});

describe("parseListeningPromptFromMetadata", () => {
  it("decodes the metadata wrapper to a typed prompt", () => {
    const prompt = buildListeningPrompt({ kind: "transcription", clip: baseClip, pool: [] })!;
    const metadata = ListeningItemMetadataSchema.parse({ listening: prompt });
    expect(parseListeningPromptFromMetadata(metadata)).toEqual(prompt);
  });

  it("returns null when the metadata is missing the listening wrapper", () => {
    expect(parseListeningPromptFromMetadata({ other: "thing" })).toBeNull();
    expect(parseListeningPromptFromMetadata(null)).toBeNull();
  });

  it("rejects malformed prompts at parse time", () => {
    expect(
      ListeningPromptSchema.safeParse({
        kind: "mc_english",
        question: "",
        choices: [],
        answerIndex: 0,
        expectedText: null,
      }).success,
    ).toBe(false);
  });
});
