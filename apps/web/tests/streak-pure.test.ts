import { describe, expect, it } from "vitest";
import {
  decideStreakUpdate,
  formatLocalDay,
  monthKeyFromLocalDate,
  parseMinutesOfDay,
  shouldSendReminder,
  type StreakUpdateInput,
} from "@/lib/streak/pure";

// Pure-function coverage for the VOL-135 streak + reminder rules:
//   * Streak idempotence ("already practised today" never advances),
//   * Streak continues across consecutive days,
//   * Free-pass fires only when yesterday was missed, partner also missed
//     yesterday, and the token is unspent for the local month,
//   * Timezone boundaries — Singapore at 23:30 vs UTC — bucket the day on
//     the user's local calendar,
//   * Reminder gating respects the user's `reminder_time`, practice state,
//     and the daily idempotency log.

function baseInput(overrides: Partial<StreakUpdateInput> = {}): StreakUpdateInput {
  return {
    current: null,
    now: new Date("2026-05-15T05:00:00Z"),
    timezone: "Asia/Singapore",
    partner: null,
    freePassUsedThisMonth: false,
    ...overrides,
  };
}

describe("decideStreakUpdate", () => {
  it("starts the streak at 1 on the user's first session", () => {
    const decision = decideStreakUpdate(baseInput());
    expect(decision.next.currentLength).toBe(1);
    expect(decision.next.longestLength).toBe(1);
    expect(decision.next.lastPracticedOn).toBe("2026-05-15");
    expect(decision.bumped).toBe(true);
    expect(decision.freePass).toBeNull();
  });

  it("does not advance when the user already practised today", () => {
    const decision = decideStreakUpdate(
      baseInput({
        current: { currentLength: 4, longestLength: 7, lastPracticedOn: "2026-05-15" },
      }),
    );
    expect(decision.bumped).toBe(false);
    expect(decision.next.currentLength).toBe(4);
    expect(decision.freePass).toBeNull();
  });

  it("extends the streak when yesterday was practised", () => {
    const decision = decideStreakUpdate(
      baseInput({
        current: { currentLength: 3, longestLength: 3, lastPracticedOn: "2026-05-14" },
      }),
    );
    expect(decision.next.currentLength).toBe(4);
    expect(decision.next.longestLength).toBe(4);
    expect(decision.bumped).toBe(true);
    expect(decision.freePass).toBeNull();
  });

  it("uses the timezone-local yesterday so Singapore midnight rolls over cleanly", () => {
    // 2026-05-14T17:00:00Z = 2026-05-15 01:00 in Singapore. The user
    // practised "yesterday" Singapore-time on 2026-05-14 local; the row
    // should extend from 3 → 4 even though UTC has not yet hit 2026-05-15.
    const decision = decideStreakUpdate(
      baseInput({
        now: new Date("2026-05-14T17:00:00Z"),
        current: { currentLength: 3, longestLength: 3, lastPracticedOn: "2026-05-14" },
      }),
    );
    expect(decision.next.lastPracticedOn).toBe("2026-05-15");
    expect(decision.next.currentLength).toBe(4);
    expect(decision.bumped).toBe(true);
  });

  it("resets to 1 when the user missed multiple days and free-pass cannot save them", () => {
    const decision = decideStreakUpdate(
      baseInput({
        // Last practiced 4 days ago — too far back for the free-pass to bridge.
        current: { currentLength: 9, longestLength: 9, lastPracticedOn: "2026-05-11" },
      }),
    );
    expect(decision.next.currentLength).toBe(1);
    expect(decision.next.longestLength).toBe(9);
    expect(decision.bumped).toBe(true);
    expect(decision.freePass).toBeNull();
  });

  it("auto-applies the free-pass in a solo household when yesterday was missed", () => {
    const decision = decideStreakUpdate(
      baseInput({
        // Last practiced on day before yesterday → missed yesterday → token covers it.
        current: { currentLength: 5, longestLength: 5, lastPracticedOn: "2026-05-13" },
      }),
    );
    expect(decision.next.currentLength).toBe(6);
    expect(decision.next.longestLength).toBe(6);
    expect(decision.freePass).toEqual({
      appliedForDate: "2026-05-14",
      monthKey: "2026-05",
    });
  });

  it("auto-applies the free-pass when the partner also missed yesterday", () => {
    const decision = decideStreakUpdate(
      baseInput({
        current: { currentLength: 5, longestLength: 5, lastPracticedOn: "2026-05-13" },
        partner: { lastPracticedOn: "2026-05-12", timezone: "Asia/Singapore" },
      }),
    );
    expect(decision.freePass).not.toBeNull();
    expect(decision.next.currentLength).toBe(6);
  });

  it("does NOT apply the free-pass when the partner practised yesterday", () => {
    // PRD: free-pass is for "both miss" — if the partner was on top of it,
    // the lazy user's streak should still reset.
    const decision = decideStreakUpdate(
      baseInput({
        current: { currentLength: 5, longestLength: 5, lastPracticedOn: "2026-05-13" },
        partner: { lastPracticedOn: "2026-05-14", timezone: "Asia/Singapore" },
      }),
    );
    expect(decision.freePass).toBeNull();
    expect(decision.next.currentLength).toBe(1);
  });

  it("does NOT apply the free-pass when the token is already spent this month", () => {
    const decision = decideStreakUpdate(
      baseInput({
        current: { currentLength: 5, longestLength: 5, lastPracticedOn: "2026-05-13" },
        freePassUsedThisMonth: true,
      }),
    );
    expect(decision.freePass).toBeNull();
    expect(decision.next.currentLength).toBe(1);
  });
});

describe("shouldSendReminder", () => {
  // 2026-05-15T12:00:00Z = 20:00 SGT — right on the user's reminder.
  const baseNow = new Date("2026-05-15T12:00:00Z");

  it("sends when reminder_time has just passed and the user has not practised", () => {
    expect(
      shouldSendReminder({
        now: baseNow,
        timezone: "Asia/Singapore",
        reminderTime: "20:00:00",
        practicedToday: false,
        alreadySentToday: false,
      }),
    ).toBe(true);
  });

  it("does not send before the configured reminder_time", () => {
    expect(
      shouldSendReminder({
        now: new Date("2026-05-15T11:00:00Z"), // 19:00 SGT
        timezone: "Asia/Singapore",
        reminderTime: "20:00:00",
        practicedToday: false,
        alreadySentToday: false,
      }),
    ).toBe(false);
  });

  it("does not send when the user already practised today", () => {
    expect(
      shouldSendReminder({
        now: baseNow,
        timezone: "Asia/Singapore",
        reminderTime: "20:00:00",
        practicedToday: true,
        alreadySentToday: false,
      }),
    ).toBe(false);
  });

  it("does not send when a reminder for today is already in the log", () => {
    expect(
      shouldSendReminder({
        now: baseNow,
        timezone: "Asia/Singapore",
        reminderTime: "20:00:00",
        practicedToday: false,
        alreadySentToday: true,
      }),
    ).toBe(false);
  });

  it("respects the tolerance window so an hourly cron picks up a 20:00 slot", () => {
    // Cron fires at 20:45 SGT. The reminder was set for 20:00, so the
    // 60-minute default window still covers it.
    expect(
      shouldSendReminder({
        now: new Date("2026-05-15T12:45:00Z"),
        timezone: "Asia/Singapore",
        reminderTime: "20:00:00",
        practicedToday: false,
        alreadySentToday: false,
      }),
    ).toBe(true);
    // But 21:30 SGT is outside the window — we don't catch up reminders
    // we missed entirely.
    expect(
      shouldSendReminder({
        now: new Date("2026-05-15T13:30:00Z"),
        timezone: "Asia/Singapore",
        reminderTime: "20:00:00",
        practicedToday: false,
        alreadySentToday: false,
      }),
    ).toBe(false);
  });
});

describe("formatLocalDay + monthKeyFromLocalDate", () => {
  it("rolls forward at midnight in the user's zone", () => {
    expect(formatLocalDay(new Date("2026-05-14T16:00:00Z"), "Asia/Singapore")).toBe("2026-05-15");
    expect(formatLocalDay(new Date("2026-05-14T16:00:00Z"), "UTC")).toBe("2026-05-14");
  });

  it("month-key tracks the local calendar across the year boundary", () => {
    // 2025-12-31 23:30 in Honolulu = 2026-01-01 09:30 UTC. The user's local
    // calendar still says December 2025; the month-key follows the local day.
    const localDay = formatLocalDay(new Date("2026-01-01T09:30:00Z"), "Pacific/Honolulu");
    expect(localDay).toBe("2025-12-31");
    expect(monthKeyFromLocalDate(localDay)).toBe("2025-12");
  });
});

describe("parseMinutesOfDay", () => {
  it("accepts HH:MM and HH:MM:SS", () => {
    expect(parseMinutesOfDay("20:00")).toBe(20 * 60);
    expect(parseMinutesOfDay("20:00:00")).toBe(20 * 60);
    expect(parseMinutesOfDay("07:30:42")).toBe(7 * 60 + 30);
  });

  it("rejects malformed values", () => {
    expect(parseMinutesOfDay("8:00")).toBeNull();
    expect(parseMinutesOfDay("24:00")).toBeNull();
    expect(parseMinutesOfDay("20:60")).toBeNull();
    expect(parseMinutesOfDay("hello")).toBeNull();
  });
});
