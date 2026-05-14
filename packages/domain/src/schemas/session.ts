import { z } from "zod";
import { SCHEMA_VERSIONS } from "../versions.js";
import { PracticeItemTypeSchema } from "./practice.js";

export const SESSION_STATUSES = [
  "pending",
  "active",
  "paused",
  "completed",
  "abandoned",
] as const;
export const SessionStatusSchema = z.enum(SESSION_STATUSES);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionItemSchema = z.object({
  itemId: z.string().min(1),
  itemType: PracticeItemTypeSchema,
  completedAt: z.string().datetime().nullable(),
  rating: z.enum(["again", "hard", "good", "easy"]).nullable(),
  correct: z.boolean().nullable(),
});
export type SessionItem = z.infer<typeof SessionItemSchema>;

export const SessionSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSIONS.session),
  id: z.string().uuid(),
  userId: z.string().uuid(),
  status: SessionStatusSchema,
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  xpEarned: z.number().int().nonnegative().default(0),
  items: z.array(SessionItemSchema).default([]),
});
export type Session = z.infer<typeof SessionSchema>;

export const XP_EVENT_TYPES = [
  "session_completed",
  "item_correct",
  "item_perfect",
  "streak_milestone",
  "first_lesson",
  "daily_goal",
] as const;
export const XpEventTypeSchema = z.enum(XP_EVENT_TYPES);
export type XpEventType = z.infer<typeof XpEventTypeSchema>;

export const XpEventSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSIONS.xpEvent),
  id: z.string().uuid(),
  userId: z.string().uuid(),
  type: XpEventTypeSchema,
  amount: z.number().int(),
  occurredAt: z.string().datetime(),
  sessionId: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type XpEvent = z.infer<typeof XpEventSchema>;

export const STREAK_EVENT_TYPES = [
  "streak_started",
  "streak_continued",
  "streak_broken",
  "streak_freeze_used",
] as const;
export const StreakEventTypeSchema = z.enum(STREAK_EVENT_TYPES);
export type StreakEventType = z.infer<typeof StreakEventTypeSchema>;

export const StreakEventSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSIONS.streakEvent),
  id: z.string().uuid(),
  userId: z.string().uuid(),
  type: StreakEventTypeSchema,
  streakLength: z.number().int().nonnegative(),
  occurredAt: z.string().datetime(),
});
export type StreakEvent = z.infer<typeof StreakEventSchema>;
