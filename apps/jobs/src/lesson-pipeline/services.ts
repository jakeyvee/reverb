// Dependency-injection seam for the lesson pipeline. Production code uses
// `defaultPipelineServices()` to wire the real provider adapters; tests pass a
// stub so they can exercise the orchestrator without hitting Groq/Anthropic.
import {
  transcribeAudioWithGroq,
  type TranscribeAudioInput,
  type TranscribeAudioResult,
} from "@reverb/ai";

export type Transcriber = (input: TranscribeAudioInput) => Promise<TranscribeAudioResult>;

export type PipelineServices = {
  transcribe: Transcriber;
};

export function defaultPipelineServices(): PipelineServices {
  return { transcribe: transcribeAudioWithGroq };
}
