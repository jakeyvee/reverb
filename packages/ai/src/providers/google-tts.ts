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

export interface SynthesizeInput {
  text: string;
  languageCode: string;
  voiceName?: string;
}

export async function synthesizeSpeech(input: SynthesizeInput): Promise<Buffer> {
  const client = getGoogleTtsClient();
  const [response] = await client.synthesizeSpeech({
    input: { text: input.text },
    voice: { languageCode: input.languageCode, name: input.voiceName },
    audioConfig: { audioEncoding: "MP3" },
  });
  const audio = response.audioContent;
  if (!audio) throw new Error("Google TTS returned no audio content");
  return Buffer.isBuffer(audio) ? audio : Buffer.from(audio);
}
