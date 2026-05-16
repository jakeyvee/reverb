import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, TablesInsert } from "@reverb/db/types";
import { sendStreakReminderEmail } from "@reverb/email";
import { formatLocalDay, monthKeyFromLocalDate, shouldSendReminder } from "./pure";

// VOL-135: server-side reminder dispatcher.
//
// Called by `/api/cron/streak-reminders` on every cron tick. The job is:
//   1. Pull the profile roster with reminder_enabled=true.
//   2. For each profile, decide via the pure predicate whether the
//      reminder is due in their local timezone right now.
//   3. If due, check the streak_reminder_log for an existing row keyed on
//      (user_id, local_date) — if present we skip (idempotency).
//   4. Send the Resend email, then insert a notification_events row and a
//      streak_reminder_log row in the same dispatch so future cron ticks
//      see the dedupe entry.
//
// "Already practised today" is determined from the user's streak row
// (`last_practiced_on`) rather than the practice_events stream. That keeps
// the path one query — and we always bump the streak row at completion
// time, so it's the most authoritative "did the user practise today"
// signal we have.

export type DispatchSummary = {
  scanned: number;
  /** Reminders that were eligible (not practised yet, not already sent). */
  eligible: number;
  /** Reminders actually sent through Resend. */
  sent: number;
  /** Eligible reminders that Resend rejected (HTTP non-2xx or transport). */
  failed: number;
  /** Per-failure error lines so the cron caller can log them at ERROR level. */
  errors: Array<{ userId: string; reason: string }>;
};

export type DispatchOptions = {
  now?: Date;
  /**
   * Tolerance window in minutes around each user's reminder_time. The cron
   * tick should be wider than the run interval — 60 min is a safe default
   * for an hourly cron with a buffer for late starts.
   */
  windowMinutes?: number;
  /**
   * Test seam — override the email sender. Defaults to the production
   * Resend dispatcher.
   */
  sendEmail?: typeof sendStreakReminderEmail;
};

type ProfileRow = {
  id: string;
  display_name: string;
  timezone: string;
  reminder_time: string;
  reminder_enabled: boolean;
};

type StreakRow = {
  user_id: string;
  current_length: number;
  last_practiced_on: string | null;
};

// `auth.admin.getUserById` resolver. Mirrors the lesson pipeline's pattern:
// production calls auth.admin; tests can pass a map-backed stub via the
// returned function.
export type RecipientEmailResolver = (userId: string) => Promise<string | null>;

export function defaultRecipientResolver(
  supabase: SupabaseClient<Database>,
): RecipientEmailResolver {
  return async (userId) => {
    try {
      const { data, error } = await supabase.auth.admin.getUserById(userId);
      if (error) return null;
      return data.user?.email ?? null;
    } catch {
      return null;
    }
  };
}

export async function dispatchStreakReminders(
  supabase: SupabaseClient<Database>,
  resolveEmail: RecipientEmailResolver,
  options: DispatchOptions = {},
): Promise<DispatchSummary> {
  const now = options.now ?? new Date();
  const windowMinutes = options.windowMinutes ?? 60;
  const sender = options.sendEmail ?? sendStreakReminderEmail;
  const summary: DispatchSummary = {
    scanned: 0,
    eligible: 0,
    sent: 0,
    failed: 0,
    errors: [],
  };

  // Roster: every user with reminders enabled. The reminder_time + timezone
  // gate runs in code so we can stay agnostic of the user's local clock.
  const { data: profiles, error: profilesError } = await supabase
    .from("profiles")
    .select("id, display_name, timezone, reminder_time, reminder_enabled")
    .eq("reminder_enabled", true);
  if (profilesError) {
    summary.errors.push({ userId: "*", reason: profilesError.message });
    return summary;
  }
  const roster: ProfileRow[] = profiles ?? [];
  summary.scanned = roster.length;
  if (roster.length === 0) return summary;

  const userIds = roster.map((row) => row.id);
  const [streakResp, reminderLogResp, freePassResp] = await Promise.all([
    supabase
      .from("streaks")
      .select("user_id, current_length, last_practiced_on")
      .in("user_id", userIds),
    supabase
      .from("streak_reminder_log")
      .select("user_id, reminder_date, channel")
      .in("user_id", userIds)
      .gte("reminder_date", formatLocalDay(new Date(now.getTime() - 86_400_000), "UTC")),
    supabase.from("streak_free_pass_uses").select("user_id, month_key").in("user_id", userIds),
  ]);

  const streakByUser = new Map<string, StreakRow>();
  for (const row of streakResp.data ?? []) {
    streakByUser.set(row.user_id, row);
  }
  // We only care about the union of (user, reminder_date) — collapse the
  // channel column into a set per-user so the predicate can do an O(1)
  // lookup without re-querying the table.
  const sentByUser = new Map<string, Set<string>>();
  for (const row of reminderLogResp.data ?? []) {
    let set = sentByUser.get(row.user_id);
    if (!set) {
      set = new Set();
      sentByUser.set(row.user_id, set);
    }
    set.add(row.reminder_date);
  }
  const freePassByUser = new Map<string, Set<string>>();
  for (const row of freePassResp.data ?? []) {
    let set = freePassByUser.get(row.user_id);
    if (!set) {
      set = new Set();
      freePassByUser.set(row.user_id, set);
    }
    set.add(row.month_key);
  }

  for (const profile of roster) {
    const localToday = formatLocalDay(now, profile.timezone);
    const monthKey = monthKeyFromLocalDate(localToday);
    const streak = streakByUser.get(profile.id);
    const practicedToday = streak?.last_practiced_on === localToday;
    const alreadySentToday = sentByUser.get(profile.id)?.has(localToday) ?? false;

    const due = shouldSendReminder({
      now,
      timezone: profile.timezone,
      reminderTime: profile.reminder_time,
      practicedToday,
      alreadySentToday,
      windowMinutes,
    });
    if (!due) continue;

    summary.eligible += 1;

    const recipientEmail = await resolveEmail(profile.id);
    if (!recipientEmail) {
      summary.failed += 1;
      summary.errors.push({
        userId: profile.id,
        reason: "no auth.users.email resolved",
      });
      continue;
    }

    const freePassRemaining = !(freePassByUser.get(profile.id)?.has(monthKey) ?? false);
    const result = await sender({
      to: recipientEmail,
      displayName: profile.display_name,
      currentStreak: streak?.current_length ?? 0,
      freePassRemaining,
      idempotencyKey: `streak_reminder:${profile.id}:${localToday}`,
    });

    if (!result.ok) {
      summary.failed += 1;
      summary.errors.push({ userId: profile.id, reason: result.error });
      continue;
    }

    summary.sent += 1;

    // Persist the notification row + the dedupe log row. Failure here is
    // logged but doesn't roll the email back — the email already left
    // Resend. We accept that a write failure could cause a duplicate send
    // on the next cron tick; the Resend idempotency key handles the
    // duplicate inside Resend, but the user might still see two messages
    // if the key TTL expired. In practice this never happens because the
    // log write is a single-row insert that rarely fails.
    const eventInsert: TablesInsert<"notification_events"> = {
      user_id: profile.id,
      kind: "streak_reminder",
      channel: "email",
      status: "sent",
      sent_at: now.toISOString(),
      scheduled_for: now.toISOString(),
      payload: {
        local_date: localToday,
        current_streak: streak?.current_length ?? 0,
        free_pass_remaining: freePassRemaining,
        resend_message_id: result.messageId,
      },
    };
    const { data: insertedEvent, error: eventError } = await supabase
      .from("notification_events")
      .insert(eventInsert)
      .select("id")
      .maybeSingle();
    if (eventError) {
      summary.errors.push({
        userId: profile.id,
        reason: `notification_events insert failed: ${eventError.message}`,
      });
    }

    const logInsert: TablesInsert<"streak_reminder_log"> = {
      user_id: profile.id,
      reminder_date: localToday,
      channel: "email",
      notification_event_id: insertedEvent?.id ?? null,
      sent_at: now.toISOString(),
    };
    const { error: logError } = await supabase.from("streak_reminder_log").insert(logInsert);
    if (logError && logError.code !== "23505") {
      summary.errors.push({
        userId: profile.id,
        reason: `streak_reminder_log insert failed: ${logError.message}`,
      });
    }
  }

  return summary;
}
