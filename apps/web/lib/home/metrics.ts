import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@reverb/db/types";

// Home-screen aggregations: streaks, 7-day heatmap, and weekly XP race.
//
// The two unusual pieces here are scoring and timezones:
//
//   * Scoring uses a *home-display* XP table — the PRD's flat per-kind
//     weights — instead of the orchestrator's rating-tiered XP awards. The
//     two views can drift safely: in-session XP rewards confidence,
//     home weekly XP rewards activity. Each entry below is a stable
//     home-facing number; bumping orchestrator weights does not change
//     last week's leaderboard.
//
//   * Timezones are per-user. The streaks table already records the user's
//     timezone; the heatmap and weekly XP loaders fold practice_events into
//     calendar days using each user's `profiles.timezone`. This keeps the
//     "did partner practice today?" nudge honest when the household spans
//     a date line.
//
// RLS note: `practice_events` and `streaks` are scoped to `auth.uid()`, so
// the partner row would be invisible to the current user via the normal
// server client. The loader takes a Supabase client passed in by the caller
// — `loadHomeMetricsForCurrentUser` constructs the service-role client and
// constrains every read to the caller's `household_id`, which is the same
// scope `profiles_select_same_household` already permits the user to see.

export const HOME_XP_WEIGHTS = {
  vocab_review: 1,
  shadowing: 3,
  grammar_exercise: 2,
  scenario: 10,
  correction_drill: 5,
} as const;

export type HomeXpKind = keyof typeof HOME_XP_WEIGHTS;

export const HEATMAP_DAYS = 7;

type SessionItemKind = Database["public"]["Enums"]["practice_item_kind"];

// Resolves a practice_session_items.kind into a HOME_XP_WEIGHTS bucket. The
// orchestrator currently emits only `card` and `mistake_drill`; the other
// branches are wired for forward compatibility so adding a grammar or
// dialogue item kind doesn't silently drop XP. Returns null when we
// genuinely can't classify the row (unknown kind or null session_item).
export function resolveHomeXpKind(kind: SessionItemKind | null | undefined): HomeXpKind | null {
  switch (kind) {
    case "card":
      return "vocab_review";
    case "mistake_drill":
      return "correction_drill";
    case "grammar_exercise":
      return "grammar_exercise";
    case "dialogue_clip":
      return "shadowing";
    default:
      return null;
  }
}

export type RawPracticeEvent = {
  userId: string;
  occurredAt: string;
  sessionItemKind: SessionItemKind | null;
};

export type HomeUserMetrics = {
  userId: string;
  displayName: string;
  isCurrentUser: boolean;
  timezone: string;
  currentStreak: number;
  longestStreak: number;
  lastPracticedOn: string | null;
  practicedToday: boolean;
  // True for any of the last `HEATMAP_DAYS` calendar days the user answered
  // at least one practice item in their local timezone. Index 0 is the
  // oldest day in the window; index HEATMAP_DAYS-1 is today.
  heatmap: boolean[];
  weeklyXp: number;
};

export type HomeMetrics = {
  // The signed-in user always comes first so the UI can render "You" on the
  // left without an extra lookup.
  users: HomeUserMetrics[];
  windowStart: string;
  windowEnd: string;
};

export type LoadHomeMetricsArgs = {
  householdId: string;
  currentUserId: string;
  now?: Date;
};

// Pure aggregation — given the household roster, the streak rows, and the
// flattened practice_events for the heatmap window, build the per-user
// metrics. Pulled out so the rules ("how is `practicedToday` decided",
// "how are XP weights applied", "which day does a 23:50 local event count
// as") can be tested without a database round-trip.
export function aggregateHomeMetrics(args: {
  members: ReadonlyArray<{ userId: string; displayName: string; timezone: string }>;
  streaks: ReadonlyArray<{
    userId: string;
    currentLength: number;
    longestLength: number;
    lastPracticedOn: string | null;
  }>;
  events: ReadonlyArray<RawPracticeEvent>;
  currentUserId: string;
  now: Date;
}): HomeMetrics {
  const streaksByUser = new Map(args.streaks.map((row) => [row.userId, row] as const));

  const users = args.members.map((member): HomeUserMetrics => {
    const streak = streaksByUser.get(member.userId);
    const localToday = formatLocalDay(args.now, member.timezone);
    const heatmapDays = buildHeatmapDays(args.now, member.timezone);
    const heatmap = heatmapDays.map(() => false);
    let weeklyXp = 0;

    for (const event of args.events) {
      if (event.userId !== member.userId) continue;
      const day = formatLocalDay(new Date(event.occurredAt), member.timezone);
      const dayIndex = heatmapDays.indexOf(day);
      if (dayIndex !== -1) heatmap[dayIndex] = true;
      const kind = resolveHomeXpKind(event.sessionItemKind);
      // Events that fall in the heatmap window contribute to weekly XP.
      // Events older than the window are loaded only by accident (none
      // should be returned) but we still gate them here so a wider query
      // doesn't inflate the totals.
      if (dayIndex !== -1 && kind) {
        weeklyXp += HOME_XP_WEIGHTS[kind];
      }
    }

    return {
      userId: member.userId,
      displayName: member.displayName,
      isCurrentUser: member.userId === args.currentUserId,
      timezone: member.timezone,
      currentStreak: streak?.currentLength ?? 0,
      longestStreak: streak?.longestLength ?? 0,
      lastPracticedOn: streak?.lastPracticedOn ?? null,
      practicedToday: heatmap[heatmap.length - 1] || streak?.lastPracticedOn === localToday,
      heatmap,
      weeklyXp,
    };
  });

  users.sort((a, b) => {
    if (a.isCurrentUser === b.isCurrentUser) {
      return a.displayName.localeCompare(b.displayName);
    }
    return a.isCurrentUser ? -1 : 1;
  });

  const referenceTimezone = users[0]?.timezone ?? args.members[0]?.timezone ?? "UTC";
  const windowEnd = formatLocalDay(args.now, referenceTimezone);
  const heatmapDays = buildHeatmapDays(args.now, referenceTimezone);
  const windowStart = heatmapDays[0] ?? windowEnd;

  return { users, windowStart, windowEnd };
}

// Build the partner-nudge string for the session-end / home screen. Returns
// null when there is no partner, when the partner already practised today,
// or when the current user themselves haven't practised — we only nudge in
// the "you did it, they haven't" direction so the message stays warm.
export function buildPartnerNudge(metrics: HomeMetrics): string | null {
  const currentUser = metrics.users.find((u) => u.isCurrentUser);
  const partner = metrics.users.find((u) => !u.isCurrentUser);
  if (!currentUser || !partner) return null;
  if (!currentUser.practicedToday) return null;
  if (partner.practicedToday) return null;
  return `${partner.displayName} hasn't practised today — keep the streak alive together.`;
}

// ---- Loader ----------------------------------------------------------

export async function loadHomeMetrics(
  supabase: SupabaseClient<Database>,
  args: LoadHomeMetricsArgs,
): Promise<HomeMetrics> {
  const now = args.now ?? new Date();

  // Household roster. Includes the current user — `profiles_select_same_
  // household` lets the user see every member of their own household, so
  // even the anon-key client could read this; we go through the same path
  // for consistency.
  const { data: profiles, error: profilesError } = await supabase
    .from("profiles")
    .select("id, display_name, timezone")
    .eq("household_id", args.householdId);
  if (profilesError) {
    throw new Error(`Could not load household profiles: ${profilesError.message}`);
  }
  const members = (profiles ?? []).map((row) => ({
    userId: row.id,
    displayName: row.display_name,
    timezone: row.timezone,
  }));
  if (members.length === 0) {
    return { users: [], windowStart: "", windowEnd: "" };
  }

  const userIds = members.map((m) => m.userId);
  // 8 day window: 7 days of heatmap plus a safety margin so a partner who
  // practised at 23:55 UTC but lives in UTC-7 is still bucketed correctly
  // on their local "today".
  const windowStart = new Date(now.getTime() - 8 * 86_400_000).toISOString();

  const [{ data: events, error: eventsError }, { data: streakRows, error: streaksError }] =
    await Promise.all([
      supabase
        .from("practice_events")
        .select(
          "user_id, occurred_at, session_item:practice_session_items(kind)",
        )
        .in("user_id", userIds)
        .eq("kind", "item_answered")
        .gte("occurred_at", windowStart),
      supabase
        .from("streaks")
        .select("user_id, current_length, longest_length, last_practiced_on")
        .in("user_id", userIds),
    ]);

  if (eventsError) {
    throw new Error(`Could not load practice events: ${eventsError.message}`);
  }
  if (streaksError) {
    throw new Error(`Could not load streaks: ${streaksError.message}`);
  }

  const flatEvents: RawPracticeEvent[] = (events ?? []).map((row) => {
    const item = Array.isArray(row.session_item) ? row.session_item[0] : row.session_item;
    return {
      userId: row.user_id,
      occurredAt: row.occurred_at,
      sessionItemKind: item?.kind ?? null,
    };
  });

  const streaks = (streakRows ?? []).map((row) => ({
    userId: row.user_id,
    currentLength: row.current_length,
    longestLength: row.longest_length,
    lastPracticedOn: row.last_practiced_on,
  }));

  return aggregateHomeMetrics({
    members,
    streaks,
    events: flatEvents,
    currentUserId: args.currentUserId,
    now,
  });
}

// ---- Timezone helpers ------------------------------------------------

// Returns the calendar date the `date` value falls on when expressed in
// `timezone`. We use Intl.DateTimeFormat rather than mutating UTC offsets so
// DST boundaries land on the correct local day.
export function formatLocalDay(date: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: safeTimezone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA emits YYYY-MM-DD natively.
  return formatter.format(date);
}

export function buildHeatmapDays(now: Date, timezone: string): string[] {
  const tz = safeTimezone(timezone);
  const days: string[] = [];
  // Walk back from today in the user's local timezone. We can't simply
  // subtract 24h because of DST — instead we step the day-of-month down by
  // formatting each intermediate UTC reference into the user's zone.
  for (let i = HEATMAP_DAYS - 1; i >= 0; i--) {
    const reference = new Date(now.getTime() - i * 86_400_000);
    days.push(formatLocalDay(reference, tz));
  }
  return days;
}

function safeTimezone(tz: string): string {
  // Intl throws on unknown zones. We deliberately don't validate at the
  // profile-edit layer (Supabase Auth UI never set it), so we degrade to
  // UTC here if a stale value sneaks through.
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}
