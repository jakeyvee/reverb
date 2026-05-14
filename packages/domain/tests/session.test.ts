import { describe, expect, it } from "vitest";
import {
  SessionSchema,
  StreakEventSchema,
  XpEventSchema,
} from "../src/schemas/session.js";
import { SCHEMA_VERSIONS } from "../src/versions.js";

const userId = "00000000-0000-4000-8000-000000000001";
const sessionId = "00000000-0000-4000-8000-000000000002";

describe("SessionSchema", () => {
  it("accepts a pending session", () => {
    const parsed = SessionSchema.parse({
      schemaVersion: SCHEMA_VERSIONS.session,
      id: sessionId,
      userId,
      status: "pending",
      startedAt: "2026-05-14T10:00:00.000Z",
      endedAt: null,
    });
    expect(parsed.items).toEqual([]);
    expect(parsed.xpEarned).toBe(0);
  });

  it("rejects an invalid status", () => {
    const result = SessionSchema.safeParse({
      schemaVersion: SCHEMA_VERSIONS.session,
      id: sessionId,
      userId,
      status: "ghosted",
      startedAt: "2026-05-14T10:00:00.000Z",
      endedAt: null,
    });
    expect(result.success).toBe(false);
  });

  it("requires a uuid for id", () => {
    const result = SessionSchema.safeParse({
      schemaVersion: SCHEMA_VERSIONS.session,
      id: "not-a-uuid",
      userId,
      status: "active",
      startedAt: "2026-05-14T10:00:00.000Z",
      endedAt: null,
    });
    expect(result.success).toBe(false);
  });
});

describe("XpEventSchema", () => {
  it("accepts a session-completed event with metadata", () => {
    const result = XpEventSchema.safeParse({
      schemaVersion: SCHEMA_VERSIONS.xpEvent,
      id: "00000000-0000-4000-8000-000000000003",
      userId,
      type: "session_completed",
      amount: 25,
      occurredAt: "2026-05-14T10:30:00.000Z",
      sessionId,
      metadata: { itemsCompleted: 12 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown event type", () => {
    const result = XpEventSchema.safeParse({
      schemaVersion: SCHEMA_VERSIONS.xpEvent,
      id: "00000000-0000-4000-8000-000000000003",
      userId,
      type: "gold_star",
      amount: 1,
      occurredAt: "2026-05-14T10:30:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});

describe("StreakEventSchema", () => {
  it("accepts a streak_continued event", () => {
    const result = StreakEventSchema.safeParse({
      schemaVersion: SCHEMA_VERSIONS.streakEvent,
      id: "00000000-0000-4000-8000-000000000004",
      userId,
      type: "streak_continued",
      streakLength: 7,
      occurredAt: "2026-05-14T10:30:00.000Z",
    });
    expect(result.success).toBe(true);
  });

  it("rejects negative streak length", () => {
    const result = StreakEventSchema.safeParse({
      schemaVersion: SCHEMA_VERSIONS.streakEvent,
      id: "00000000-0000-4000-8000-000000000004",
      userId,
      type: "streak_started",
      streakLength: -1,
      occurredAt: "2026-05-14T10:30:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});
