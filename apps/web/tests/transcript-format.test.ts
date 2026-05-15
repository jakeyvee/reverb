import { describe, expect, it } from "vitest";
import { formatSpeaker, formatTimestamp } from "@/lib/lessons/transcript-format";

describe("formatSpeaker", () => {
  it("falls back to 'Unknown speaker' when the label is missing", () => {
    expect(formatSpeaker(null).display).toBe("Unknown speaker");
    expect(formatSpeaker(undefined).display).toBe("Unknown speaker");
    expect(formatSpeaker("").display).toBe("Unknown speaker");
    expect(formatSpeaker("   ").display).toBe("Unknown speaker");
  });

  it("maps canonical speaker labels to friendly display names", () => {
    expect(formatSpeaker("teacher").display).toBe("Teacher");
    expect(formatSpeaker("student_vincent").display).toBe("Vincent");
    expect(formatSpeaker("student_gf").display).toBe("Partner");
    expect(formatSpeaker("unknown").display).toBe("Unknown speaker");
  });

  it("preserves raw diarization labels but still assigns a tone", () => {
    const a = formatSpeaker("SPEAKER_00");
    const b = formatSpeaker("SPEAKER_01");
    expect(a.display).toBe("SPEAKER_00");
    expect(b.display).toBe("SPEAKER_01");
    // Two different labels should not collapse to the same speaker key, so
    // the legend keeps them distinguishable.
    expect(a.key).not.toBe(b.key);
    expect(a.tone).toBeTruthy();
  });

  it("returns the same tone for the same raw label across calls", () => {
    const first = formatSpeaker("SPEAKER_00");
    const second = formatSpeaker("SPEAKER_00");
    expect(first.tone).toBe(second.tone);
    expect(first.key).toBe(second.key);
  });

  it("uses different tones for the canonical speakers", () => {
    const tones = new Set([
      formatSpeaker("teacher").tone,
      formatSpeaker("student_vincent").tone,
      formatSpeaker("student_gf").tone,
    ]);
    expect(tones.size).toBe(3);
  });
});

describe("formatTimestamp", () => {
  it("formats sub-minute timestamps as 0:SS", () => {
    expect(formatTimestamp(0)).toBe("0:00");
    expect(formatTimestamp(450)).toBe("0:00");
    expect(formatTimestamp(1000)).toBe("0:01");
    expect(formatTimestamp(9_500)).toBe("0:09");
  });

  it("formats minute-scale timestamps as M:SS", () => {
    expect(formatTimestamp(60_000)).toBe("1:00");
    expect(formatTimestamp(65_000)).toBe("1:05");
    expect(formatTimestamp(125_500)).toBe("2:05");
  });

  it("formats hour-scale timestamps as H:MM:SS with zero-padded minutes", () => {
    expect(formatTimestamp(3_600_000)).toBe("1:00:00");
    expect(formatTimestamp(3_725_000)).toBe("1:02:05");
  });

  it("guards against bad inputs", () => {
    expect(formatTimestamp(-1)).toBe("0:00");
    expect(formatTimestamp(Number.NaN)).toBe("0:00");
    expect(formatTimestamp(Number.POSITIVE_INFINITY)).toBe("0:00");
  });
});
