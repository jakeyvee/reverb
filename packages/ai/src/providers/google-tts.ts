import { createHash } from "node:crypto";
import { TextToSpeechClient } from "@google-cloud/text-to-speech";
import { aiEnv } from "../env.js";

let cached: TextToSpeechClient | null = null;

export function getGoogleTtsClient(): TextToSpeechClient {
  if (cached) return cached;

  const inlineJson = aiEnv.googleAppCredentialsJson();
  if (inlineJson) {
    // Hosted runtimes (e.g. Trigger.dev) have no persistent filesystem, so
    // we accept the service-account key as an inline JSON string.
    cached = new TextToSpeechClient({ credentials: JSON.parse(inlineJson) });
    return cached;
  }

  const apiKey = aiEnv.googleTtsKey();
  if (apiKey) {
    cached = new TextToSpeechClient({ apiKey });
    return cached;
  }

  // Falls back to Application Default Credentials, including the file path in
  // GOOGLE_APPLICATION_CREDENTIALS when set (typical for local development).
  cached = new TextToSpeechClient();
  return cached;
}

export const GOOGLE_TTS_PROVIDER_ID = "google-tts" as const;

// MVP defaults for Indonesian vocab. Wavenet voices have markedly better
// prosody than the Standard set for one- and two-word headwords, which is
// exactly the shape we're synthesising. The voice is pinned (rather than
// pulled from env) so the cache key stays stable across deploys; switching
// to a different voice intentionally produces a different storage object.
export const INDONESIAN_LANGUAGE_CODE = "id-ID" as const;
export const DEFAULT_INDONESIAN_VOICE = "id-ID-Wavenet-A" as const;

export const TTS_CACHE_BUCKET = "tts-cache" as const;

export type TtsAudioEncoding = "MP3" | "OGG_OPUS" | "LINEAR16";

export interface SynthesizeRequest {
  input: { text: string };
  voice: { languageCode: string; name: string };
  audioConfig: { audioEncoding: TtsAudioEncoding };
}

export interface SynthesizeInput {
  text: string;
  languageCode?: string;
  voiceName?: string;
  audioEncoding?: TtsAudioEncoding;
}

// Pure mapping from our adapter inputs to the Google synthesize request body.
// Kept side-effect free so tests can assert the exact payload we'd send
// without booting the SDK.
export function buildSynthesizeRequest(input: SynthesizeInput): SynthesizeRequest {
  const text = input.text.trim();
  if (text.length === 0) {
    throw new Error("synthesizeSpeech: text is empty after trimming");
  }
  return {
    input: { text },
    voice: {
      languageCode: input.languageCode ?? INDONESIAN_LANGUAGE_CODE,
      name: input.voiceName ?? DEFAULT_INDONESIAN_VOICE,
    },
    audioConfig: { audioEncoding: input.audioEncoding ?? "MP3" },
  };
}

export async function synthesizeSpeech(input: SynthesizeInput): Promise<Buffer> {
  const client = getGoogleTtsClient();
  const request = buildSynthesizeRequest(input);
  const [response] = await client.synthesizeSpeech(request);
  const audio = response.audioContent;
  if (!audio) throw new Error("Google TTS returned no audio content");
  return Buffer.isBuffer(audio) ? audio : Buffer.from(audio);
}

export interface TtsCacheKeyInput {
  text: string;
  languageCode?: string;
  voiceName?: string;
}

export interface TtsCacheKey {
  /** Canonicalised text fed to the hash + provider. */
  text: string;
  languageCode: string;
  voiceName: string;
  /** Hex sha256 over `${voiceName}|${languageCode}|${text}` — stable per voice. */
  hash: string;
}

// Canonical text used for hashing and for the request body. Lowercased so two
// vocab items that disagree on capitalisation ("Kopi" vs "kopi") collapse to
// a single cached object. Whitespace is normalised so a stray trailing space
// in the extractor's output does not produce a second cache entry.
export function canonicalizeTtsText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLocaleLowerCase("id-ID");
}

// Deterministic content-addressed key for the cache. The voice name is part
// of the hash input so generating Wavenet-A and Wavenet-B audio for the same
// word lands on different objects; we want it that way because the bytes
// differ.
export function ttsCacheKey(input: TtsCacheKeyInput): TtsCacheKey {
  const text = canonicalizeTtsText(input.text);
  if (text.length === 0) {
    throw new Error("ttsCacheKey: text is empty after canonicalisation");
  }
  const languageCode = input.languageCode ?? INDONESIAN_LANGUAGE_CODE;
  const voiceName = input.voiceName ?? DEFAULT_INDONESIAN_VOICE;
  const hash = createHash("sha256").update(`${voiceName}|${languageCode}|${text}`).digest("hex");
  return { text, languageCode, voiceName, hash };
}

// Path layout in the `tts-cache` bucket. The first folder must match the
// caller's household_id to satisfy the storage RLS policy in
// 20260514120007_storage_buckets.sql.
export function ttsCacheStoragePath(args: {
  householdId: string;
  key: TtsCacheKey;
  ext?: "mp3";
}): string {
  if (!args.householdId) throw new Error("ttsCacheStoragePath: householdId is required");
  const ext = args.ext ?? "mp3";
  return `${args.householdId}/${GOOGLE_TTS_PROVIDER_ID}/${args.key.voiceName}/${args.key.hash}.${ext}`;
}
