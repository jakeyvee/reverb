import { z } from "zod";
import { SCHEMA_VERSIONS } from "../versions.js";
import { SpeakerLabelSchema, StudentSpeakerSchema } from "./speaker.js";

export const DifficultySchema = z.enum(["beginner", "intermediate", "advanced"]);
export type Difficulty = z.infer<typeof DifficultySchema>;

export const ExtractionCategorySchema = z.enum([
  "grammar",
  "vocab",
  "pronunciation",
  "usage",
  "other",
]);
export type ExtractionCategory = z.infer<typeof ExtractionCategorySchema>;

export const CorrectionSeveritySchema = z.enum(["minor", "moderate", "major"]);
export type CorrectionSeverity = z.infer<typeof CorrectionSeveritySchema>;

export const DialogueFocusSchema = z.enum([
  "vocab",
  "grammar",
  "listening",
  "shadowing",
  "scenario",
]);
export type DialogueFocus = z.infer<typeof DialogueFocusSchema>;

const LanguageCode = z.string().min(2);
const Seconds = z.number().nonnegative().finite();

export const NewVocabSchema = z.object({
  term: z.string().min(1),
  language: LanguageCode,
  pronunciation: z.string().min(1).optional(),
  partOfSpeech: z.string().min(1).optional(),
  gloss: z.string().min(1),
  example: z.string().min(1).optional(),
  exampleGloss: z.string().min(1).optional(),
  sourceSegmentIds: z.array(z.string().min(1)).default([]),
  difficulty: DifficultySchema.optional(),
});
export type NewVocab = z.infer<typeof NewVocabSchema>;

export const GrammarExampleSchema = z.object({
  target: z.string().min(1),
  gloss: z.string().min(1),
});
export type GrammarExample = z.infer<typeof GrammarExampleSchema>;

export const GrammarPatternSchema = z.object({
  pattern: z.string().min(1),
  language: LanguageCode,
  explanation: z.string().min(1),
  examples: z.array(GrammarExampleSchema).min(1),
  sourceSegmentIds: z.array(z.string().min(1)).default([]),
  difficulty: DifficultySchema.optional(),
});
export type GrammarPattern = z.infer<typeof GrammarPatternSchema>;

export const DialogueClipSchema = z
  .object({
    id: z.string().min(1),
    startSegmentId: z.string().min(1),
    endSegmentId: z.string().min(1),
    startSec: Seconds,
    endSec: Seconds,
    title: z.string().min(1),
    description: z.string().optional(),
    participants: z.array(SpeakerLabelSchema).min(1),
    language: LanguageCode,
    focus: DialogueFocusSchema.optional(),
  })
  .refine((c) => c.endSec >= c.startSec, {
    message: "endSec must be >= startSec",
    path: ["endSec"],
  });
export type DialogueClip = z.infer<typeof DialogueClipSchema>;

export const TeacherCorrectionSchema = z.object({
  studentSpeaker: StudentSpeakerSchema,
  segmentId: z.string().min(1),
  utterance: z.string().min(1),
  correction: z.string().min(1),
  rationale: z.string().min(1).optional(),
  category: ExtractionCategorySchema,
  severity: CorrectionSeveritySchema.optional(),
});
export type TeacherCorrection = z.infer<typeof TeacherCorrectionSchema>;

export const ExtractionOutputSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSIONS.extractionOutput),
  promptVersion: z.string().min(1),
  language: LanguageCode,
  sourceTranscriptId: z.string().min(1),
  new_vocab: z.array(NewVocabSchema).default([]),
  grammar_patterns: z.array(GrammarPatternSchema).default([]),
  dialogue_clips: z.array(DialogueClipSchema).default([]),
  teacher_corrections: z.array(TeacherCorrectionSchema).default([]),
});
export type ExtractionOutput = z.infer<typeof ExtractionOutputSchema>;
