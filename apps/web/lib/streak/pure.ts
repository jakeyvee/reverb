// VOL-135: pure helpers for the streak free-pass + reminder pipeline.
//
// Why this lives in its own module:
//   * The orchestrator's `bumpStreakForToday` used to format dates in UTC.
//     UTC bracketing is wrong once two users share a household across time
//     zones: at 23:30 in Singapore (UTC+8) the user has already rolled into
//     a new calendar day, but UTC still says yesterday. The functions here
//     accept an explicit timezone and use Intl.DateTimeFormat so the day
//     bucket lands on the user's local calendar — DST + date-line safe.
//   * The free-pass policy ("preserve the streak when both users would
//     otherwise miss, but only once a month") needs to be exercised in
//     unit tests without a Supabase round-trip. Splitting the decision
//     into a pure function makes that trivial.

// 1 day in milliseconds. Used only as an offset for "shift today by N days
// in the user's timezone" — we then re-format via Intl so DST boundaries
// don't drop or add an hour.
const ONE_DAY_MS = 86_400_000;

export type StreakSnapshot = {
  currentLength: number;
  longestLength: number;
  /** ISO local date `YYYY-MM-DD` in the user's tz, or null if never practised. */
  lastPracticedOn: string | null;
};

export type StreakPartnerInput = {
  /** Partner's local date (`YYYY-MM-DD`) of their last practice, or null. */
  lastPracticedOn: string | null;
  /** Partner's timezone — used to compute their local yesterday. */
  timezone: string;
};

// Inputs to `decideStreakUpdate`. The shape is plain values rather than a
// Supabase row so the test suite can exercise edge cases (DST jump, missed
// day, free-pass already burned this month) without a DB.
export type StreakUpdateInput = {
  /** The user's existing streak snapshot, or null if none yet. */
  current: StreakSnapshot | null;
  /** Wall-clock instant the user completed today's session. */
  now: Date;
  /** Their IANA timezone — same column as `profiles.timezone`. */
  timezone: string;
  /** Partner row, if the household has one. */
  partner: StreakPartnerInput | null;
  /**
   * True if the user has already consumed their free-pass for the calendar
   * month identified by `now` (in their local timezone).
   */
  freePassUsedThisMonth: boolean;
};

export type StreakUpdateDecision = {
  /** What the streak row should become. */
  next: StreakSnapshot;
  /** Whether currentLength advanced compared to the input. */
  bumped: boolean;
  /**
   * Set when the free-pass token was burned by this update. Carries the
   * local-date the token covered so the caller can write the
   * `streak_free_pass_uses` row + log a `streak_free_pass_applied` payload.
   */
  freePass: {
    appliedForDate: string;
    monthKey: string;
  } | null;
};

// Decide what should happen to the streak when the user completes today's
// session. Idempotent for "already practised today" — the streak stays put
// and `bumped` is false.
//
// The free-pass auto-application rule (per VOL-135 PRD):
//   * Yesterday was missed (last_practiced_on === day_before_yesterday),
//   * The partner (if any) also missed yesterday,
//   * The user still has an unspent free-pass for the current local month.
// When all three hold we credit yesterday as practised, advance the streak
// from there, and stamp the token as consumed.
export function decideStreakUpdate(input: StreakUpdateInput): StreakUpdateDecision {
  const today = formatLocalDay(input.now, input.timezone);
  const yesterday = formatLocalDay(addDays(input.now, -1), input.timezone);
  const dayBeforeYesterday = formatLocalDay(addDays(input.now, -2), input.timezone);

  if (input.current?.lastPracticedOn === today) {
    return {
      next: input.current,
      bumped: false,
      freePass: null,
    };
  }

  const last = input.current?.lastPracticedOn ?? null;
  const continued = last === yesterday;

  // Free-pass eligibility: yesterday was missed (exactly one day gap), the
  // partner also missed yesterday (or there is no partner), and the token
  // is unspent.
  const partnerMissedYesterday =
    input.partner === null ? true : input.partner.lastPracticedOn !== yesterday;
  const freePassEligible =
    !continued &&
    !input.freePassUsedThisMonth &&
    last === dayBeforeYesterday &&
    partnerMissedYesterday;

  if (freePassEligible) {
    const baseLength = input.current?.currentLength ?? 0;
    const nextLength = baseLength + 1; // yesterday counted via free-pass; today extends by one.
    const nextLongest = Math.max(input.current?.longestLength ?? 0, nextLength);
    return {
      next: {
        currentLength: nextLength,
        longestLength: nextLongest,
        lastPracticedOn: today,
      },
      bumped: true,
      freePass: {
        appliedForDate: yesterday,
        monthKey: monthKeyFromLocalDate(yesterday),
      },
    };
  }

  // Normal path: continue if last was yesterday, otherwise restart at 1.
  const baseLength = continued ? (input.current?.currentLength ?? 0) : 0;
  const nextLength = baseLength + 1;
  const nextLongest = Math.max(input.current?.longestLength ?? 0, nextLength);
  return {
    next: {
      currentLength: nextLength,
      longestLength: nextLongest,
      lastPracticedOn: today,
    },
    bumped: true,
    freePass: null,
  };
}

// ---- Reminder helpers --------------------------------------------------

export type ReminderDecisionInput = {
  /** Current wall-clock instant the cron evaluator is firing at. */
  now: Date;
  /** User profile timezone. */
  timezone: string;
  /** `HH:MM:SS` time-of-day stored on the profile. */
  reminderTime: string;
  /** True if the user already finished a session today (their tz). */
  practicedToday: boolean;
  /** True if a reminder for today's local date is already in the log. */
  alreadySentToday: boolean;
  /**
   * Tolerance window in minutes around `reminderTime`. The cron route fires
   * hourly, so a 60-minute window means a reminder configured for 20:00
   * goes out on the run that covers 19:30–20:30 local time.
   */
  windowMinutes?: number;
};

// Decides whether to send today's reminder for one user. Splits cleanly so
// the cron route can iterate the household roster, call this, and only
// touch Resend/log tables when the decision says "send".
export function shouldSendReminder(input: ReminderDecisionInput): boolean {
  if (input.practicedToday) return false;
  if (input.alreadySentToday) return false;

  const tolerance = Math.max(1, input.windowMinutes ?? 60);
  const nowMinutes = localMinutesOfDay(input.now, input.timezone);
  const reminderMinutes = parseMinutesOfDay(input.reminderTime);
  if (reminderMinutes === null) return false;
  // Reminder is "due" once the user's local clock has reached the
  // reminder_time and we are still within the tolerance window. We don't
  // send before the configured time — only at-or-after, so a user who set
  // 20:00 never sees a 19:30 nudge.
  return nowMinutes >= reminderMinutes && nowMinutes - reminderMinutes <= tolerance;
}

// ---- Date / time formatters ------------------------------------------

// Format a `Date` as the local `YYYY-MM-DD` for the user's timezone. Uses
// Intl rather than UTC offset math so DST and date-line edges stay correct.
export function formatLocalDay(date: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: safeTimezone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(date);
}

// `YYYY-MM` for the user's local time. Derived from formatLocalDay so the
// month boundary respects the user's timezone.
export function monthKeyFromLocalDate(localDate: string): string {
  return localDate.slice(0, 7);
}

export function localMinutesOfDay(date: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: safeTimezone(timezone),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  // en-GB emits "HH:MM" or "HH:MM:SS" with hour12=false. We slice to the
  // first 5 characters defensively.
  const value = formatter.format(date).slice(0, 5);
  return parseMinutesOfDay(value) ?? 0;
}

export function parseMinutesOfDay(value: string): number | null {
  const match = value.match(/^(\d{2}):(\d{2})(?::\d{2})?$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * ONE_DAY_MS);
}

function safeTimezone(tz: string): string {
  // Intl.DateTimeFormat throws on unknown zones. Stay defensive — UTC is the
  // existing fallback already used by `lib/home/metrics.ts`.
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}
