import { z } from "zod";
import { SCHEMA_VERSIONS } from "../versions.js";
import { SpeakerLabelSchema } from "./speaker.js";

const Confidence = z.number().min(0).max(1);

// Per-segment diarization label produced by the LLM. The text of the segment
// is intentionally absent here — diarization never modifies the underlying
// transcript text. Persistence merges this onto the existing transcript row.
export const DiarizationSegmentLabelSchema = z.object({
  segmentId: z.string().min(1),
  speaker: SpeakerLabelSchema,
  confidence: Confidence,
  // English / code-switched / teacher-meta segments stay in the transcript view
  // but extraction skips them because they're not the language we're learning.
  lowPriority: z.boolean().default(false),
  // Optional one-line rationale. Lets us audit weird picks and gives the UI a
  // tooltip surface without re-reading the prompt context.
  notes: z.string().min(1).optional(),
});
export type DiarizationSegmentLabel = z.infer<typeof DiarizationSegmentLabelSchema>;

// Full diarization output returned by the prompt + parser. The prompt/version
// pair is persisted alongside so a later issue can reprocess only the lessons
// whose labels came from an older prompt without re-doing the ASR.
export const DiarizationOutputSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSIONS.diarization),
  promptVersion: z.string().min(1),
  model: z.string().min(1),
  sourceTranscriptId: z.string().min(1),
  segments: z.array(DiarizationSegmentLabelSchema),
});
export type DiarizationOutput = z.infer<typeof DiarizationOutputSchema>;

// Input shape passed to the diarization adapter. We send the LLM only the
// minimum needed to label speakers — segment id, time range, language hint,
// and the original ASR text — and never round-trip word-level timestamps.
export const DiarizationInputSegmentSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  startSec: z.number().nonnegative().finite(),
  endSec: z.number().nonnegative().finite(),
  language: z.string().min(2).optional(),
});
export type DiarizationInputSegment = z.infer<typeof DiarizationInputSegmentSchema>;

export const DiarizationInputSchema = z.object({
  sourceTranscriptId: z.string().min(1),
  language: z.string().min(2),
  segments: z.array(DiarizationInputSegmentSchema),
});
export type DiarizationInput = z.infer<typeof DiarizationInputSchema>;
