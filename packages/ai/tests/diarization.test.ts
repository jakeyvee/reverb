import { describe, expect, it } from "vitest";
import { SCHEMA_VERSIONS, type DiarizationInput } from "@reverb/domain";
import {
  DIARIZATION_PROMPT_VERSION,
  DIARIZATION_SYSTEM_PROMPT,
  buildDiarizationUserPrompt,
  parseDiarizationResponse,
} from "../src/prompts/diarization.js";

// Typical teacher/student correction exchange. Vincent attempts a sentence,
// the teacher restates it correctly in Indonesian, then briefly translates
// the meaning into English before handing the next prompt to Vincent's gf.
// This is the shape the diarization step encounters most often.
const correctionExchange: DiarizationInput = {
  sourceTranscriptId: "lesson-42",
  language: "id",
  segments: [
    {
      id: "S0",
      text: "Selamat pagi semuanya. Hari ini kita belajar tentang waktu.",
      startSec: 0,
      endSec: 4.2,
    },
    { id: "S1", text: "Saya pergi sekolah kemarin.", startSec: 4.5, endSec: 6.8 },
    {
      id: "S2",
      text: "Bagus. Tapi seharusnya: Saya pergi ke sekolah kemarin.",
      startSec: 7.0,
      endSec: 10.4,
    },
    {
      id: "S3",
      text: "So you need the preposition ke before sekolah.",
      startSec: 10.6,
      endSec: 13.2,
      language: "en",
    },
    { id: "S4", text: "Saya pergi ke pasar kemarin.", startSec: 13.5, endSec: 16.0 },
  ],
};

describe("buildDiarizationUserPrompt", () => {
  it("emits one labeled line per segment with the prompt id and time range", () => {
    const out = buildDiarizationUserPrompt(correctionExchange);
    expect(out).toContain("[S0] (0.00s–4.20s) Selamat pagi semuanya.");
    expect(out).toContain("[S1] (4.50s–6.80s) Saya pergi sekolah kemarin.");
    expect(out).toContain("[S4] (13.50s–16.00s) Saya pergi ke pasar kemarin.");
  });

  it("flags code-switched segments with a language tag in the listing", () => {
    const out = buildDiarizationUserPrompt(correctionExchange);
    expect(out).toContain("lang=en) So you need the preposition");
  });

  it("includes the lesson language and source id so the model has context", () => {
    const out = buildDiarizationUserPrompt(correctionExchange);
    expect(out).toContain("Lesson language: id.");
    expect(out).toContain("Source transcript id: lesson-42.");
  });
});

describe("DIARIZATION_SYSTEM_PROMPT", () => {
  it("explicitly tells the model to prefer unknown over guessing", () => {
    expect(DIARIZATION_SYSTEM_PROMPT).toMatch(/Prefer "unknown" over guessing/);
  });

  it("calls out the code-switching / lowPriority rule", () => {
    expect(DIARIZATION_SYSTEM_PROMPT).toMatch(/lowPriority=true/);
    expect(DIARIZATION_SYSTEM_PROMPT).toMatch(/transcript view/);
  });

  it("instructs the model not to modify segment text", () => {
    expect(DIARIZATION_SYSTEM_PROMPT).toMatch(/Do NOT modify the segment text/);
  });

  it("pins the four-label closed set", () => {
    expect(DIARIZATION_SYSTEM_PROMPT).toMatch(/teacher, student_vincent, student_gf, unknown/);
  });
});

describe("parseDiarizationResponse", () => {
  const parseOpts = {
    sourceTranscriptId: "lesson-42",
    model: "claude-haiku-4-5-20251001",
  };

  it("parses a clean JSON response into a domain DiarizationOutput", () => {
    const responseJson = JSON.stringify({
      promptVersion: DIARIZATION_PROMPT_VERSION,
      segments: [
        { segmentId: "S0", speaker: "teacher", confidence: 0.95, lowPriority: false },
        { segmentId: "S1", speaker: "student_vincent", confidence: 0.78, lowPriority: false },
        {
          segmentId: "S2",
          speaker: "teacher",
          confidence: 0.92,
          lowPriority: false,
          notes: "explicit correction phrase 'seharusnya'",
        },
        {
          segmentId: "S3",
          speaker: "teacher",
          confidence: 0.85,
          lowPriority: true,
          notes: "English meta-explanation",
        },
        { segmentId: "S4", speaker: "unknown", confidence: 0.3, lowPriority: false },
      ],
    });

    const parsed = parseDiarizationResponse(responseJson, parseOpts);
    expect(parsed.schemaVersion).toBe(SCHEMA_VERSIONS.diarization);
    expect(parsed.promptVersion).toBe(DIARIZATION_PROMPT_VERSION);
    expect(parsed.model).toBe(parseOpts.model);
    expect(parsed.sourceTranscriptId).toBe("lesson-42");
    expect(parsed.segments).toHaveLength(5);

    const correction = parsed.segments.find((s) => s.segmentId === "S2");
    expect(correction?.speaker).toBe("teacher");
    expect(correction?.notes).toMatch(/seharusnya/);

    const codeSwitch = parsed.segments.find((s) => s.segmentId === "S3");
    expect(codeSwitch?.lowPriority).toBe(true);

    // Acceptance: ambiguous segments come back as `unknown`, not dropped.
    const ambiguous = parsed.segments.find((s) => s.segmentId === "S4");
    expect(ambiguous?.speaker).toBe("unknown");
  });

  it("strips markdown fences if the model wrapped the JSON in ```json ... ```", () => {
    const responseJson = [
      "Here is the JSON output:",
      "```json",
      JSON.stringify({
        promptVersion: DIARIZATION_PROMPT_VERSION,
        segments: [{ segmentId: "S0", speaker: "teacher", confidence: 0.9 }],
      }),
      "```",
    ].join("\n");

    const parsed = parseDiarizationResponse(responseJson, parseOpts);
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.segments[0]?.speaker).toBe("teacher");
  });

  it("falls back to the canonical prompt version if the model omits it", () => {
    const responseJson = JSON.stringify({
      segments: [{ segmentId: "S0", speaker: "unknown", confidence: 0.1 }],
    });
    const parsed = parseDiarizationResponse(responseJson, parseOpts);
    expect(parsed.promptVersion).toBe(DIARIZATION_PROMPT_VERSION);
  });

  it("throws when the response is not JSON", () => {
    expect(() => parseDiarizationResponse("totally not json", parseOpts)).toThrow(/JSON object/);
  });

  it("throws when a segment uses a label outside the closed set", () => {
    const responseJson = JSON.stringify({
      promptVersion: DIARIZATION_PROMPT_VERSION,
      segments: [{ segmentId: "S0", speaker: "alien", confidence: 0.99 }],
    });
    expect(() => parseDiarizationResponse(responseJson, parseOpts)).toThrow();
  });
});
