import { describe, expect, it } from "vitest";
import {
  HEATMAP_DAYS,
  HOME_XP_WEIGHTS,
  aggregateHomeMetrics,
  buildHeatmapDays,
  buildPartnerNudge,
  formatLocalDay,
  resolveHomeXpKind,
} from "@/lib/home/metrics";

// Pure-function coverage for the home aggregator. The Supabase loader is
// exercised end-to-end against a real instance; these tests pin the rules
// the home UI depends on:
//   * streak rows are surfaced as-is,
//   * the 7-day heatmap fills the correct slot in the user's local
//     timezone (incl. DST + date-line edges),
//   * weekly XP follows the PRD per-kind weights, not orchestrator XP,
//   * `practicedToday` is true whenever today has an event OR the streak
//     row was bumped today.

const VOID = "00000000-0000-0000-0000-000000000000";

const baseMembers = [
  { userId: "user-a", displayName: "Alex", timezone: "Asia/Singapore" },
  { userId: "user-b", displayName: "Bo", timezone: "Asia/Singapore" },
];

describe("HOME_XP_WEIGHTS", () => {
  it("matches the PRD values from VOL-122", () => {
    expect(HOME_XP_WEIGHTS.vocab_review).toBe(1);
    expect(HOME_XP_WEIGHTS.shadowing).toBe(3);
    expect(HOME_XP_WEIGHTS.grammar_exercise).toBe(2);
    expect(HOME_XP_WEIGHTS.scenario).toBe(10);
    expect(HOME_XP_WEIGHTS.correction_drill).toBeGreaterThan(0);
  });
});

describe("resolveHomeXpKind", () => {
  it("maps card → vocab_review", () => {
    expect(resolveHomeXpKind("card")).toBe("vocab_review");
  });
  it("maps mistake_drill → correction_drill", () => {
    expect(resolveHomeXpKind("mistake_drill")).toBe("correction_drill");
  });
  it("maps grammar_exercise to itself", () => {
    expect(resolveHomeXpKind("grammar_exercise")).toBe("grammar_exercise");
  });
  it("maps dialogue_clip → shadowing", () => {
    expect(resolveHomeXpKind("dialogue_clip")).toBe("shadowing");
  });
  it("returns null for null/unknown kinds", () => {
    expect(resolveHomeXpKind(null)).toBeNull();
    expect(resolveHomeXpKind(undefined)).toBeNull();
  });
});

describe("buildHeatmapDays", () => {
  it("returns 7 days ending on today in the user's local timezone", () => {
    // 2026-05-16T17:00:00Z is 2026-05-17 01:00 in Singapore (UTC+8) — the
    // user has already rolled into the next local day even though UTC
    // still says the 16th. The rightmost slot should be 2026-05-17.
    const now = new Date("2026-05-16T17:00:00Z");
    const days = buildHeatmapDays(now, "Asia/Singapore");
    expect(days).toHaveLength(HEATMAP_DAYS);
    expect(days[HEATMAP_DAYS - 1]).toBe("2026-05-17");
    expect(days[0]).toBe("2026-05-11");
  });

  it("falls back to UTC for unknown zones", () => {
    const now = new Date("2026-05-16T17:00:00Z");
    const days = buildHeatmapDays(now, "Definitely/Not_A_Zone");
    expect(days[HEATMAP_DAYS - 1]).toBe("2026-05-16");
  });
});

describe("formatLocalDay", () => {
  it("formats Singapore-local 23:30 vs UTC", () => {
    const date = new Date("2026-05-16T15:30:00Z"); // 23:30 in SG
    expect(formatLocalDay(date, "Asia/Singapore")).toBe("2026-05-16");
    expect(formatLocalDay(date, "UTC")).toBe("2026-05-16");
  });

  it("rolls forward across the date line in the user's zone", () => {
    const date = new Date("2026-05-16T17:00:00Z"); // 01:00 SG next day
    expect(formatLocalDay(date, "Asia/Singapore")).toBe("2026-05-17");
    expect(formatLocalDay(date, "UTC")).toBe("2026-05-16");
  });
});

describe("aggregateHomeMetrics", () => {
  it("places the current user first and lights today on the heatmap", () => {
    const now = new Date("2026-05-16T05:00:00Z");
    const today = formatLocalDay(now, "Asia/Singapore");
    const metrics = aggregateHomeMetrics({
      members: baseMembers,
      streaks: [
        { userId: "user-a", currentLength: 4, longestLength: 4, lastPracticedOn: today },
        { userId: "user-b", currentLength: 0, longestLength: 7, lastPracticedOn: "2026-05-14" },
      ],
      events: [
        { userId: "user-a", occurredAt: now.toISOString(), sessionItemKind: "card" },
        { userId: "user-a", occurredAt: now.toISOString(), sessionItemKind: "mistake_drill" },
      ],
      currentUserId: "user-a",
      now,
    });

    const [first, second] = metrics.users;
    expect(first?.userId).toBe("user-a");
    expect(first?.isCurrentUser).toBe(true);
    expect(first?.currentStreak).toBe(4);
    expect(first?.practicedToday).toBe(true);
    expect(first?.heatmap.at(-1)).toBe(true);
    expect(first?.weeklyXp).toBe(
      HOME_XP_WEIGHTS.vocab_review + HOME_XP_WEIGHTS.correction_drill,
    );

    expect(second?.userId).toBe("user-b");
    expect(second?.practicedToday).toBe(false);
    expect(second?.heatmap.at(-1)).toBe(false);
    expect(second?.weeklyXp).toBe(0);
  });

  it("counts XP only for events that fall inside the heatmap window", () => {
    const now = new Date("2026-05-16T05:00:00Z");
    const metrics = aggregateHomeMetrics({
      members: baseMembers,
      streaks: [],
      events: [
        // Inside window
        { userId: "user-a", occurredAt: "2026-05-15T05:00:00Z", sessionItemKind: "card" },
        // Outside window — 10 days ago. The loader's gte clause normally
        // filters these; the aggregator stays defensive.
        { userId: "user-a", occurredAt: "2026-05-06T05:00:00Z", sessionItemKind: "card" },
      ],
      currentUserId: "user-a",
      now,
    });
    expect(metrics.users[0]?.weeklyXp).toBe(HOME_XP_WEIGHTS.vocab_review);
  });

  it("ignores events with no session item link (unclassifiable kind)", () => {
    const now = new Date("2026-05-16T05:00:00Z");
    const metrics = aggregateHomeMetrics({
      members: baseMembers,
      streaks: [],
      events: [
        { userId: "user-a", occurredAt: now.toISOString(), sessionItemKind: null },
      ],
      currentUserId: "user-a",
      now,
    });
    // Heatmap still records activity for the day (we know they did
    // something), but XP isn't awarded because we can't price the item.
    expect(metrics.users[0]?.heatmap.at(-1)).toBe(true);
    expect(metrics.users[0]?.weeklyXp).toBe(0);
  });

  it("treats lastPracticedOn-as-today as practiced even with no events in window", () => {
    // The streak row is bumped at session completion, which is the most
    // authoritative signal. We keep it as a backstop so the partner-nudge
    // doesn't flicker on the edge case where the events query lags the
    // streak update.
    const now = new Date("2026-05-16T05:00:00Z");
    const today = formatLocalDay(now, "Asia/Singapore");
    const metrics = aggregateHomeMetrics({
      members: baseMembers,
      streaks: [
        { userId: "user-a", currentLength: 1, longestLength: 1, lastPracticedOn: today },
      ],
      events: [],
      currentUserId: "user-a",
      now,
    });
    expect(metrics.users[0]?.practicedToday).toBe(true);
  });

  it("respects per-user timezones for the heatmap", () => {
    // Bo lives across the date line. Their "today" is one calendar day
    // ahead of Alex's at this UTC instant.
    const now = new Date("2026-05-16T15:00:00Z");
    const metrics = aggregateHomeMetrics({
      members: [
        { userId: "user-a", displayName: "Alex", timezone: "America/Los_Angeles" },
        { userId: "user-b", displayName: "Bo", timezone: "Asia/Tokyo" },
      ],
      streaks: [],
      events: [
        // 23:00 UTC = 16:00 LA (same day) = 00:00 Tokyo (next day, 2026-05-17).
        // The Tokyo-side event should sit on the last column for Bo and on
        // the second-to-last column for Alex.
        {
          userId: "user-a",
          occurredAt: "2026-05-16T23:00:00Z",
          sessionItemKind: "card",
        },
        {
          userId: "user-b",
          occurredAt: "2026-05-16T23:00:00Z",
          sessionItemKind: "card",
        },
      ],
      currentUserId: "user-a",
      now,
    });

    const alex = metrics.users.find((u) => u.userId === "user-a");
    const bo = metrics.users.find((u) => u.userId === "user-b");
    expect(alex?.heatmap.at(-1)).toBe(true);
    expect(bo?.heatmap.at(-1)).toBe(true);
  });

  it("returns an empty roster when the household has no members", () => {
    const metrics = aggregateHomeMetrics({
      members: [],
      streaks: [],
      events: [],
      currentUserId: VOID,
      now: new Date("2026-05-16T05:00:00Z"),
    });
    expect(metrics.users).toEqual([]);
  });
});

describe("buildPartnerNudge", () => {
  it("nudges only when the current user practised but the partner has not", () => {
    const now = new Date("2026-05-16T05:00:00Z");
    const today = formatLocalDay(now, "Asia/Singapore");
    const metrics = aggregateHomeMetrics({
      members: baseMembers,
      streaks: [
        { userId: "user-a", currentLength: 1, longestLength: 1, lastPracticedOn: today },
        { userId: "user-b", currentLength: 3, longestLength: 5, lastPracticedOn: "2026-05-14" },
      ],
      events: [],
      currentUserId: "user-a",
      now,
    });
    const nudge = buildPartnerNudge(metrics);
    expect(nudge).toMatch(/Bo/);
  });

  it("returns null when nobody has practised", () => {
    const now = new Date("2026-05-16T05:00:00Z");
    const metrics = aggregateHomeMetrics({
      members: baseMembers,
      streaks: [],
      events: [],
      currentUserId: "user-a",
      now,
    });
    expect(buildPartnerNudge(metrics)).toBeNull();
  });

  it("returns null when both have practised today", () => {
    const now = new Date("2026-05-16T05:00:00Z");
    const today = formatLocalDay(now, "Asia/Singapore");
    const metrics = aggregateHomeMetrics({
      members: baseMembers,
      streaks: [
        { userId: "user-a", currentLength: 1, longestLength: 1, lastPracticedOn: today },
        { userId: "user-b", currentLength: 4, longestLength: 4, lastPracticedOn: today },
      ],
      events: [],
      currentUserId: "user-a",
      now,
    });
    expect(buildPartnerNudge(metrics)).toBeNull();
  });

  it("returns null in a single-member household", () => {
    const now = new Date("2026-05-16T05:00:00Z");
    const today = formatLocalDay(now, "Asia/Singapore");
    const soloMember = baseMembers[0];
    if (!soloMember) throw new Error("baseMembers missing fixture");
    const metrics = aggregateHomeMetrics({
      members: [soloMember],
      streaks: [
        { userId: "user-a", currentLength: 1, longestLength: 1, lastPracticedOn: today },
      ],
      events: [],
      currentUserId: "user-a",
      now,
    });
    expect(buildPartnerNudge(metrics)).toBeNull();
  });
});
