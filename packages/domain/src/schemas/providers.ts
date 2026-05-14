import { z } from "zod";
import { ExtractionOutputSchema } from "./extraction.js";
import { SpeakerLabelSchema } from "./speaker.js";
import { TranscriptSchema } from "./transcript.js";

const LanguageCode = z.string().min(2);

export const ASR_PROVIDERS = ["groq-whisper", "openai-whisper", "assemblyai"] as const;
export const AsrProviderIdSchema = z.enum(ASR_PROVIDERS);
export type AsrProviderId = z.infer<typeof AsrProviderIdSchema>;

export const AsrProviderRequestSchema = z.object({
  audioUrl: z.string().url(),
  language: LanguageCode.optional(),
  speakerHints: z.array(SpeakerLabelSchema).optional(),
  diarize: z.boolean().optional(),
  prompt: z.string().optional(),
});
export type AsrProviderRequest = z.infer<typeof AsrProviderRequestSchema>;

export const AsrProviderResponseSchema = TranscriptSchema;
export type AsrProviderResponse = z.infer<typeof AsrProviderResponseSchema>;

export const EXTRACTION_PROVIDERS = ["anthropic", "groq", "openai"] as const;
export const ExtractionProviderIdSchema = z.enum(EXTRACTION_PROVIDERS);
export type ExtractionProviderId = z.infer<typeof ExtractionProviderIdSchema>;

export const ExtractionProviderRequestSchema = z.object({
  transcript: TranscriptSchema,
  promptVersion: z.string().min(1),
  targetLanguage: LanguageCode,
  studentSpeakers: z
    .array(SpeakerLabelSchema)
    .default(["student_vincent", "student_gf"]),
});
export type ExtractionProviderRequest = z.infer<typeof ExtractionProviderRequestSchema>;

export const ExtractionProviderResponseSchema = ExtractionOutputSchema;
export type ExtractionProviderResponse = z.infer<typeof ExtractionProviderResponseSchema>;

export const TTS_PROVIDERS = ["google", "elevenlabs"] as const;
export const TtsProviderIdSchema = z.enum(TTS_PROVIDERS);
export type TtsProviderId = z.infer<typeof TtsProviderIdSchema>;

export const TtsProviderRequestSchema = z.object({
  text: z.string().min(1),
  language: LanguageCode,
  voice: z.string().min(1).optional(),
  speakingRate: z.number().positive().optional(),
  pitch: z.number().optional(),
});
export type TtsProviderRequest = z.infer<typeof TtsProviderRequestSchema>;

export const TtsProviderResponseSchema = z.object({
  audioUrl: z.string().url(),
  mimeType: z.string().min(1),
  durationSec: z.number().nonnegative().optional(),
  provider: TtsProviderIdSchema,
  voice: z.string().min(1).optional(),
});
export type TtsProviderResponse = z.infer<typeof TtsProviderResponseSchema>;
