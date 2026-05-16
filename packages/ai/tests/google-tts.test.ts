import { describe, expect, it } from "vitest";
import {
  DEFAULT_INDONESIAN_VOICE,
  INDONESIAN_LANGUAGE_CODE,
  TTS_CACHE_BUCKET,
  buildSynthesizeRequest,
  canonicalizeTtsText,
  ttsCacheKey,
  ttsCacheStoragePath,
} from "../src/providers/google-tts.js";

describe("buildSynthesizeRequest", () => {
  it("defaults to the Indonesian Wavenet voice and MP3 encoding", () => {
    const req = buildSynthesizeRequest({ text: "kopi" });
    expect(req).toEqual({
      input: { text: "kopi" },
      voice: {
        languageCode: INDONESIAN_LANGUAGE_CODE,
        name: DEFAULT_INDONESIAN_VOICE,
      },
      audioConfig: { audioEncoding: "MP3" },
    });
  });

  it("trims whitespace from the input text before sending it to Google", () => {
    const req = buildSynthesizeRequest({ text: "   kopi pagi  \n" });
    expect(req.input.text).toBe("kopi pagi");
  });

  it("honours caller overrides for voice, language and encoding", () => {
    const req = buildSynthesizeRequest({
      text: "selamat pagi",
      voiceName: "id-ID-Standard-B",
      languageCode: "id-ID",
      audioEncoding: "OGG_OPUS",
    });
    expect(req.voice.name).toBe("id-ID-Standard-B");
    expect(req.voice.languageCode).toBe("id-ID");
    expect(req.audioConfig.audioEncoding).toBe("OGG_OPUS");
  });

  it("throws when the text is empty after trimming", () => {
    expect(() => buildSynthesizeRequest({ text: "   " })).toThrow(/empty after trimming/);
  });
});

describe("canonicalizeTtsText", () => {
  it("lowercases and collapses interior whitespace", () => {
    expect(canonicalizeTtsText("  Selamat   PAGI \n")).toBe("selamat pagi");
  });

  it("returns an empty string for whitespace-only input", () => {
    expect(canonicalizeTtsText("   ")).toBe("");
  });
});

describe("ttsCacheKey", () => {
  it("collapses case- and whitespace-differences to the same hash", () => {
    const a = ttsCacheKey({ text: "kopi" });
    const b = ttsCacheKey({ text: "  KOPI  " });
    expect(a.hash).toBe(b.hash);
    expect(a.text).toBe("kopi");
  });

  it("derives a different hash when the voice changes", () => {
    const wavenetA = ttsCacheKey({ text: "kopi", voiceName: "id-ID-Wavenet-A" });
    const wavenetB = ttsCacheKey({ text: "kopi", voiceName: "id-ID-Wavenet-B" });
    expect(wavenetA.hash).not.toBe(wavenetB.hash);
  });

  it("derives a different hash when the text actually differs", () => {
    expect(ttsCacheKey({ text: "kopi" }).hash).not.toBe(ttsCacheKey({ text: "teh" }).hash);
  });

  it("defaults the language and voice for the Indonesian MVP", () => {
    const key = ttsCacheKey({ text: "kopi" });
    expect(key.languageCode).toBe(INDONESIAN_LANGUAGE_CODE);
    expect(key.voiceName).toBe(DEFAULT_INDONESIAN_VOICE);
  });

  it("throws on empty input so callers cannot accidentally cache silence", () => {
    expect(() => ttsCacheKey({ text: "   " })).toThrow(/empty after canonicalisation/);
  });
});

describe("ttsCacheStoragePath", () => {
  it("places the household prefix first so the storage RLS policy is satisfied", () => {
    const key = ttsCacheKey({ text: "kopi" });
    const path = ttsCacheStoragePath({ householdId: "household-42", key });
    expect(path.startsWith("household-42/")).toBe(true);
    expect(path).toContain(`/${key.voiceName}/`);
    expect(path.endsWith(`/${key.hash}.mp3`)).toBe(true);
  });

  it("is deterministic for the same household and key", () => {
    const key = ttsCacheKey({ text: "kopi" });
    expect(ttsCacheStoragePath({ householdId: "h", key })).toBe(
      ttsCacheStoragePath({ householdId: "h", key }),
    );
  });

  it("refuses an empty household id so we never write to an unscoped path", () => {
    const key = ttsCacheKey({ text: "kopi" });
    expect(() => ttsCacheStoragePath({ householdId: "", key })).toThrow(/householdId is required/);
  });
});

describe("TTS_CACHE_BUCKET", () => {
  it("matches the private bucket provisioned in 20260514120007_storage_buckets.sql", () => {
    expect(TTS_CACHE_BUCKET).toBe("tts-cache");
  });
});
