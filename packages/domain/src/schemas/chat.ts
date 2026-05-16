import { z } from "zod";

// Chat partner shared types. Persisted columns mirror these (see the chat
// migration); the AI adapter parses model output into the same shapes so the
// web layer can hand structured corrections straight to the database without
// re-validating per call-site.

export const CHAT_MESSAGE_ROLES = ["user", "assistant"] as const;
export const ChatMessageRoleSchema = z.enum(CHAT_MESSAGE_ROLES);
export type ChatMessageRole = z.infer<typeof ChatMessageRoleSchema>;

export const CHAT_CORRECTION_KINDS = ["grammar", "vocabulary", "pronunciation", "usage"] as const;
export const ChatCorrectionKindSchema = z.enum(CHAT_CORRECTION_KINDS);
export type ChatCorrectionKind = z.infer<typeof ChatCorrectionKindSchema>;

// User-reported proficiency. We use the same labels as `extraction.DifficultySchema`
// but keep a separate alias because chat-level isn't tied to a single card —
// it conditions prompt voice, vocab band, and grammar complexity overall.
export const CHAT_LEVELS = ["beginner", "intermediate", "advanced"] as const;
export const ChatLevelSchema = z.enum(CHAT_LEVELS);
export type ChatLevel = z.infer<typeof ChatLevelSchema>;

// Bounded-history knobs. Used by both the AI adapter (recent messages it
// forwards to Anthropic) and the web layer (most-recent N for the UI hydrate
// path). One source of truth keeps the prompt size and the UI in sync.
export const CHAT_HISTORY_WINDOW = 12;
// When this many user turns elapse, the prompt builder asks the model to
// produce a fresh `summary` rather than re-feeding older turns. Cheap proxy
// for "the conversation got long enough that we should compress".
export const CHAT_SUMMARIZE_AFTER_USER_TURNS = 20;
// Vocab context we splice into the system prompt. Keeping these short caps
// the prompt size and forces the prompt builder to rank rather than dump.
export const CHAT_KNOWN_VOCAB_LIMIT = 24;
export const CHAT_RECENT_VOCAB_LIMIT = 16;
export const CHAT_RECENT_CORRECTION_LIMIT = 6;
// Cap incoming user text. The DB column is `text` (unbounded) but the
// adapter trims/limits at the boundary so a 1MB paste doesn't blow the
// Anthropic context window.
export const CHAT_USER_MESSAGE_MAX_CHARS = 1000;

export const ChatCorrectionSchema = z.object({
  kind: ChatCorrectionKindSchema.default("grammar"),
  sourceText: z.string().min(1),
  correctedText: z.string().min(1),
  explanation: z.string().optional(),
});
export type ChatCorrection = z.infer<typeof ChatCorrectionSchema>;

// Structured response we ask the model to return. The reply itself is in
// Indonesian (with English glosses allowed as parentheticals); the
// corrections array is the *only* place mistake text lives. Splitting reply
// from corrections is what lets the UI render the two in visibly distinct
// blocks without doing fragile prose parsing on the assistant text.
export const ChatAssistantResponseSchema = z.object({
  reply: z.string().min(1),
  // ISO 639-1 of the *reply*. Stored on chat_messages.language so an
  // English-fallback turn is searchable later without re-detecting.
  replyLanguage: z.string().min(2).default("id"),
  corrections: z.array(ChatCorrectionSchema).default([]),
});
export type ChatAssistantResponse = z.infer<typeof ChatAssistantResponseSchema>;

// Conditioning payload the AI adapter consumes. Composed by the web layer
// from the user's profile, vocab tables, and correction history. Splitting
// it out as a value-object lets the prompt builder be a pure function we
// can unit-test without a Supabase double.
export const ChatVocabContextItemSchema = z.object({
  lemma: z.string().min(1),
  translation: z.string().nullable().optional(),
});
export type ChatVocabContextItem = z.infer<typeof ChatVocabContextItemSchema>;

export const ChatCorrectionHistoryItemSchema = z.object({
  sourceText: z.string().min(1),
  correctedText: z.string().min(1),
  kind: ChatCorrectionKindSchema.optional(),
});
export type ChatCorrectionHistoryItem = z.infer<typeof ChatCorrectionHistoryItemSchema>;

export const ChatConversationContextSchema = z.object({
  level: ChatLevelSchema,
  // Vocab the user has marked "I already know this" or has high stability on.
  // Prefer these so the model echoes language they recognise.
  knownVocab: z.array(ChatVocabContextItemSchema).default([]),
  // Vocab from recent lessons — the freshest material the user has been
  // exposed to. Prompt asks the model to weave these in.
  recentLessonVocab: z.array(ChatVocabContextItemSchema).default([]),
  // Recent corrections the user has gotten (lesson teacher-corrections OR
  // prior chat corrections, merged by the caller). The prompt uses these to
  // double-check for the same mistake.
  recentCorrections: z.array(ChatCorrectionHistoryItemSchema).default([]),
  // Rolling summary of older turns we've already trimmed off the window.
  // Nullable so a brand-new session emits no summary line.
  rollingSummary: z.string().nullable().default(null),
});
export type ChatConversationContext = z.infer<typeof ChatConversationContextSchema>;

export const ChatTurnSchema = z.object({
  role: ChatMessageRoleSchema,
  content: z.string().min(1),
});
export type ChatTurn = z.infer<typeof ChatTurnSchema>;

// Convenience helper for the web layer / adapter: clamp a long history to
// the window we feed the model. Always keeps the tail (most recent) so the
// model sees the immediate context.
export function windowChatHistory(turns: ChatTurn[], windowSize = CHAT_HISTORY_WINDOW): ChatTurn[] {
  if (turns.length <= windowSize) return turns;
  return turns.slice(turns.length - windowSize);
}

// Decide whether the prompt builder should ask the model to compress older
// turns next call. Pure function so the web action can decide before the
// next round-trip without consulting the DB.
export function shouldSummarizeHistory(args: {
  totalUserMessages: number;
  hasSummary: boolean;
}): boolean {
  if (args.totalUserMessages < CHAT_SUMMARIZE_AFTER_USER_TURNS) return false;
  if (args.hasSummary && args.totalUserMessages % CHAT_SUMMARIZE_AFTER_USER_TURNS !== 0) {
    return false;
  }
  return true;
}
