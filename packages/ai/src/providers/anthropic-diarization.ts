import type { DiarizationInput, DiarizationOutput } from "@reverb/domain";
import { anthropicCompletion } from "./anthropic.js";
import {
  DIARIZATION_DEFAULT_MODEL,
  DIARIZATION_PROMPT_VERSION,
  DIARIZATION_SYSTEM_PROMPT,
  buildDiarizationUserPrompt,
  parseDiarizationResponse,
} from "../prompts/diarization.js";

export const ANTHROPIC_DIARIZATION_PROVIDER_ID = "anthropic-diarization";

export type InferDiarizationInput = DiarizationInput & {
  /** Override the default Anthropic model for tests / experiments. */
  model?: string;
};

export type InferDiarizationResult = {
  /** Domain-validated diarization output, ready to merge onto transcript_segments. */
  diarization: DiarizationOutput;
  /** Untrimmed model response, retained for audit / debugging. */
  rawResponse: string;
  /** Model id actually used. */
  model: string;
  /** Prompt version stamped on the run; persisted for future reprocessing. */
  promptVersion: string;
};

// Per-segment cap: ~150 tokens of JSON per segment is generous (id, label,
// confidence, optional notes). 1024 is a comfortable floor for short lessons;
// scale up linearly with segment count. The Anthropic SDK will error if we
// undershoot the actual response, so be generous rather than tight.
function estimateMaxTokens(segmentCount: number): number {
  const perSegment = 150;
  const floor = 1024;
  return Math.max(floor, Math.ceil(segmentCount * perSegment));
}

export async function inferDiarizationWithAnthropic(
  input: InferDiarizationInput,
): Promise<InferDiarizationResult> {
  const model = input.model ?? DIARIZATION_DEFAULT_MODEL;
  const userPrompt = buildDiarizationUserPrompt(input);
  const rawResponse = await anthropicCompletion({
    model,
    system: DIARIZATION_SYSTEM_PROMPT,
    user: userPrompt,
    maxTokens: estimateMaxTokens(input.segments.length),
  });

  const diarization = parseDiarizationResponse(rawResponse, {
    sourceTranscriptId: input.sourceTranscriptId,
    model,
  });

  return {
    diarization,
    rawResponse,
    model,
    promptVersion: DIARIZATION_PROMPT_VERSION,
  };
}
