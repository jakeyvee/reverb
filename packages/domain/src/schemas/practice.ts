import { z } from "zod";
import { SCHEMA_VERSIONS } from "../versions.js";
import { SpeakerLabelSchema, StudentSpeakerSchema } from "./speaker.js";

export const PRACTICE_ITEM_TYPES = [
  "vocab_review",
  "mistake_drill",
  "grammar_exercise",
  "shadowing",
  "listening_comprehension",
  "scenario",
  "chat_turn",
] as const;

export const PracticeItemTypeSchema = z.enum(PRACTICE_ITEM_TYPES);
export type PracticeItemType = z.infer<typeof PracticeItemTypeSchema>;

const LanguageCode = z.string().min(2);
const Seconds = z.number().nonnegative().finite();

const baseFields = {
  id: z.string().min(1),
  schemaVersion: z.literal(SCHEMA_VERSIONS.practiceItem),
  language: LanguageCode,
  sourceLessonId: z.string().min(1).optional(),
  sourceSegmentIds: z.array(z.string().min(1)).default([]),
  createdAt: z.string().datetime(),
};

export const VocabReviewItemSchema = z.object({
  ...baseFields,
  type: z.literal("vocab_review"),
  term: z.string().min(1),
  gloss: z.string().min(1),
  pronunciation: z.string().min(1).optional(),
  example: z.string().min(1).optional(),
  exampleGloss: z.string().min(1).optional(),
});
export type VocabReviewItem = z.infer<typeof VocabReviewItemSchema>;

export const MistakeDrillItemSchema = z.object({
  ...baseFields,
  type: z.literal("mistake_drill"),
  utterance: z.string().min(1),
  correction: z.string().min(1),
  rationale: z.string().min(1).optional(),
  studentSpeaker: StudentSpeakerSchema,
  // Carried from teacher_corrections.confidence. Optional because
  // pre-VOL-120 corrections were never scored.
  confidence: z.number().min(0).max(1).optional(),
});
export type MistakeDrillItem = z.infer<typeof MistakeDrillItemSchema>;

export const GrammarExerciseItemSchema = z.object({
  ...baseFields,
  type: z.literal("grammar_exercise"),
  pattern: z.string().min(1),
  prompt: z.string().min(1),
  answer: z.string().min(1),
  options: z.array(z.string().min(1)).optional(),
});
export type GrammarExerciseItem = z.infer<typeof GrammarExerciseItemSchema>;

const ShadowingItemObject = z.object({
  ...baseFields,
  type: z.literal("shadowing"),
  audioUrl: z.string().url(),
  text: z.string().min(1),
  startSec: Seconds.optional(),
  endSec: Seconds.optional(),
  speaker: SpeakerLabelSchema.optional(),
});

const refineShadowing = (
  item: z.infer<typeof ShadowingItemObject>,
  ctx: z.RefinementCtx,
): void => {
  if (
    item.startSec !== undefined &&
    item.endSec !== undefined &&
    item.endSec < item.startSec
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["endSec"],
      message: "endSec must be >= startSec",
    });
  }
};

export const ShadowingItemSchema = ShadowingItemObject.superRefine(refineShadowing);
export type ShadowingItem = z.infer<typeof ShadowingItemSchema>;

const ListeningComprehensionItemObject = z.object({
  ...baseFields,
  type: z.literal("listening_comprehension"),
  audioUrl: z.string().url(),
  question: z.string().min(1),
  choices: z.array(z.string().min(1)).min(2),
  answerIndex: z.number().int().nonnegative(),
});

const refineListeningComprehension = (
  item: z.infer<typeof ListeningComprehensionItemObject>,
  ctx: z.RefinementCtx,
): void => {
  if (item.answerIndex >= item.choices.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["answerIndex"],
      message: "answerIndex must be within choices",
    });
  }
};

export const ListeningComprehensionItemSchema =
  ListeningComprehensionItemObject.superRefine(refineListeningComprehension);
export type ListeningComprehensionItem = z.infer<typeof ListeningComprehensionItemSchema>;

export const ScenarioTurnSchema = z.object({
  speaker: SpeakerLabelSchema,
  text: z.string().min(1),
});
export type ScenarioTurn = z.infer<typeof ScenarioTurnSchema>;

export const ScenarioItemSchema = z.object({
  ...baseFields,
  type: z.literal("scenario"),
  context: z.string().min(1),
  goal: z.string().min(1),
  turns: z.array(ScenarioTurnSchema).min(1),
});
export type ScenarioItem = z.infer<typeof ScenarioItemSchema>;

export const ChatTurnItemSchema = z.object({
  ...baseFields,
  type: z.literal("chat_turn"),
  prompt: z.string().min(1),
  expectedTopics: z.array(z.string().min(1)).optional(),
  expectedGrammar: z.array(z.string().min(1)).optional(),
});
export type ChatTurnItem = z.infer<typeof ChatTurnItemSchema>;

export const PracticeItemSchema = z
  .discriminatedUnion("type", [
    VocabReviewItemSchema,
    MistakeDrillItemSchema,
    GrammarExerciseItemSchema,
    ShadowingItemObject,
    ListeningComprehensionItemObject,
    ScenarioItemSchema,
    ChatTurnItemSchema,
  ])
  .superRefine((item, ctx) => {
    if (item.type === "shadowing") refineShadowing(item, ctx);
    if (item.type === "listening_comprehension") refineListeningComprehension(item, ctx);
  });
export type PracticeItem = z.infer<typeof PracticeItemSchema>;
