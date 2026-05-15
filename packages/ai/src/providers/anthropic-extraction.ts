import type { ExtractionOutput } from "@reverb/domain";
import { anthropicCompletion } from "./anthropic.js";
import {
  EXTRACTION_DEFAULT_MODEL,
  EXTRACTION_PROMPT_VERSION,
  EXTRACTION_SYSTEM_PROMPT,
  buildExtractionUserPrompt,
  parseExtractionResponse,
  type ExtractionInput,
} from "../prompts/extraction.js";

export const ANTHROPIC_EXTRACTION_PROVIDER_ID = "anthropic-extraction";

export type InferExtractionInput = ExtractionInput & {
  /** Override the default Anthropic model for tests / experiments. */
  model?: string;
};

export type InferExtractionResult = {
  /** Domain-validated extraction output, ready to fan out into normalized tables. */
  extraction: ExtractionOutput;
  /** Untrimmed model response, retained for audit / debugging on extraction_runs. */
  rawResponse: string;
  /** Model id actually used. */
  model: string;
  /** Prompt version stamped on the run; persisted on extraction_runs.prompt_version. */
  promptVersion: string;
};

// Extraction emits four categories of structured data, each potentially with
// several items. The model needs comfortable headroom — under-provisioning
// here truncates the JSON and the parser throws. Per-segment estimate is
// generous; floor keeps tiny lessons from getting boxed in.
function estimateMaxTokens(segmentCount: number): number {
  const perSegment = 200;
  const floor = 4096;
  return Math.max(floor, Math.ceil(segmentCount * perSegment));
}

export async function inferExtractionWithAnthropic(
  input: InferExtractionInput,
): Promise<InferExtractionResult> {
  const model = input.model ?? EXTRACTION_DEFAULT_MODEL;
  const userPrompt = buildExtractionUserPrompt(input);
  const rawResponse = await anthropicCompletion({
    model,
    system: EXTRACTION_SYSTEM_PROMPT,
    user: userPrompt,
    maxTokens: estimateMaxTokens(input.segments.length),
  });

  const extraction = parseExtractionResponse(rawResponse, {
    sourceTranscriptId: input.sourceTranscriptId,
    language: input.language,
  });

  return {
    extraction,
    rawResponse,
    model,
    promptVersion: EXTRACTION_PROMPT_VERSION,
  };
}
