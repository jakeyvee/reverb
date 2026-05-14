import { TextToSpeechClient } from "@google-cloud/text-to-speech";

let cached: TextToSpeechClient | null = null;

export function getGoogleTtsClient(): TextToSpeechClient {
  if (!cached) cached = new TextToSpeechClient();
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
