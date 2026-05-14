import { z } from "zod";
import { SCHEMA_VERSIONS } from "../versions.js";
import { SpeakerLabelSchema } from "./speaker.js";

const Seconds = z.number().nonnegative().finite();
const Confidence = z.number().min(0).max(1);

export const WordTimestampSchema = z
  .object({
    word: z.string().min(1),
    start: Seconds,
    end: Seconds,
    confidence: Confidence.optional(),
  })
  .refine((w) => w.end >= w.start, {
    message: "word end must be >= start",
    path: ["end"],
  });
export type WordTimestamp = z.infer<typeof WordTimestampSchema>;

export const TranscriptSegmentSchema = z
  .object({
    id: z.string().min(1),
    speaker: SpeakerLabelSchema,
    text: z.string().min(1),
    start: Seconds,
    end: Seconds,
    words: z.array(WordTimestampSchema).optional(),
    confidence: Confidence.optional(),
    language: z.string().min(2).optional(),
  })
  .refine((s) => s.end >= s.start, {
    message: "segment end must be >= start",
    path: ["end"],
  });
export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

export const TranscriptSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSIONS.transcript),
  sourceId: z.string().min(1),
  language: z.string().min(2),
  durationSec: Seconds,
  provider: z.string().min(1),
  model: z.string().min(1),
  segments: z.array(TranscriptSegmentSchema),
  createdAt: z.string().datetime(),
});
export type Transcript = z.infer<typeof TranscriptSchema>;
