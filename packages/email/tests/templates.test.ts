import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderLessonFailedEmail, renderLessonReadyEmail } from "../src/templates.js";

const ORIGINAL_APP_URL = process.env.APP_URL;

beforeEach(() => {
  process.env.APP_URL = "https://app.example.test";
});

afterEach(() => {
  if (ORIGINAL_APP_URL === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = ORIGINAL_APP_URL;
});

describe("renderLessonReadyEmail", () => {
  it("includes the lesson title, summary counts, and app links", () => {
    const rendered = renderLessonReadyEmail({
      lessonTitle: "Bahasa basics: ordering coffee",
      lessonId: "lesson-123",
      counts: {
        newVocab: 7,
        grammarPatterns: 2,
        teacherCorrections: 1,
        dialogueClips: 3,
      },
    });

    expect(rendered.subject).toContain("Bahasa basics: ordering coffee");
    expect(rendered.html).toContain("Bahasa basics: ordering coffee");
    expect(rendered.html).toContain("New words");
    expect(rendered.html).toContain("Grammar patterns");
    expect(rendered.html).toContain("Corrections");
    expect(rendered.html).toContain("Dialogue clips");
    expect(rendered.html).toContain("7");
    expect(rendered.html).toContain("https://app.example.test/lessons/lesson-123");
    expect(rendered.html).toContain("https://app.example.test/session");

    expect(rendered.text).toContain("Bahasa basics: ordering coffee");
    expect(rendered.text).toContain("New words: 7");
    expect(rendered.text).toContain("https://app.example.test/lessons/lesson-123");
  });

  it("skips counts that are zero so the email stays scannable", () => {
    const rendered = renderLessonReadyEmail({
      lessonTitle: "Quiet lesson",
      lessonId: "lesson-xyz",
      counts: { newVocab: 3, grammarPatterns: 0, teacherCorrections: 0, dialogueClips: 0 },
    });
    expect(rendered.html).toContain("New words");
    expect(rendered.html).not.toContain("Grammar patterns");
    expect(rendered.html).not.toContain("Corrections");
    expect(rendered.html).not.toContain("Dialogue clips");
    expect(rendered.text).toContain("New words: 3");
    expect(rendered.text).not.toContain("Grammar patterns");
  });

  it("escapes lesson titles so an attacker-controlled title cannot inject HTML", () => {
    const rendered = renderLessonReadyEmail({
      lessonTitle: `<img src=x onerror="alert(1)">`,
      lessonId: "lesson-xss",
      counts: { newVocab: 1, grammarPatterns: 0, teacherCorrections: 0, dialogueClips: 0 },
    });
    expect(rendered.html).not.toContain("<img");
    expect(rendered.html).toContain("&lt;img");
    // The subject is plain text so it doesn't need encoding, but it must
    // still pass through verbatim.
    expect(rendered.subject).toContain(`<img src=x onerror="alert(1)">`);
  });
});

describe("renderLessonFailedEmail", () => {
  it("includes the error summary, stage, and retry link", () => {
    const rendered = renderLessonFailedEmail({
      lessonTitle: "Glitchy upload",
      lessonId: "lesson-fail",
      errorSummary: "Groq Whisper returned 429",
      stage: "transcribing",
      attempt: 2,
    });
    expect(rendered.subject).toContain("Glitchy upload");
    expect(rendered.html).toContain("Groq Whisper returned 429");
    expect(rendered.html).toContain("transcribing");
    expect(rendered.html).toContain("attempt 2");
    expect(rendered.html).toContain("https://app.example.test/upload");
    expect(rendered.text).toContain("Retry: https://app.example.test/upload");
  });

  it("renders cleanly when there is no error summary or stage", () => {
    const rendered = renderLessonFailedEmail({
      lessonTitle: "Mystery failure",
      lessonId: "lesson-fail-2",
      errorSummary: null,
      stage: null,
      attempt: 1,
    });
    expect(rendered.html).toContain("Mystery failure");
    expect(rendered.html).not.toContain("What went wrong");
    expect(rendered.html).not.toContain("Stage:");
    expect(rendered.text).not.toContain("Stage:");
  });
});
