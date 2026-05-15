// Dependency-injection seam for the lesson pipeline. Production code uses
// `defaultPipelineServices()` to wire the real provider adapters; tests pass a
// stub so they can exercise the orchestrator without hitting Groq/Anthropic.
import {
  inferDiarizationWithAnthropic,
  inferExtractionWithAnthropic,
  transcribeAudioWithGroq,
  type InferDiarizationInput,
  type InferDiarizationResult,
  type InferExtractionInput,
  type InferExtractionResult,
  type TranscribeAudioInput,
  type TranscribeAudioResult,
} from "@reverb/ai";

export type Transcriber = (input: TranscribeAudioInput) => Promise<TranscribeAudioResult>;
export type Diarizer = (input: InferDiarizationInput) => Promise<InferDiarizationResult>;
export type Extractor = (input: InferExtractionInput) => Promise<InferExtractionResult>;

export type PipelineServices = {
  transcribe: Transcriber;
  diarize: Diarizer;
  extract: Extractor;
};

export function defaultPipelineServices(): PipelineServices {
  return {
    transcribe: transcribeAudioWithGroq,
    diarize: inferDiarizationWithAnthropic,
    extract: inferExtractionWithAnthropic,
  };
}
