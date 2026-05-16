import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@reverb/db/types";
import {
  decideStreakUpdate,
  formatLocalDay,
  monthKeyFromLocalDate,
  type StreakPartnerInput,
  type StreakSnapshot,
  type StreakUpdateDecision,
} from "./pure";

// VOL-135: glue between the pure streak/free-pass policy and the DB.
//
// Two responsibilities:
//   1. Load the inputs the pure decision needs (user streak row, partner
//      streak row, free-pass token state).
//   2. Persist the resulting streak snapshot and (when consumed) the
//      free-pass token row.
//
// Idempotency note: the free-pass token row has PK (user_id, month_key), so
// a duplicate insert (a second tab racing to complete today's session)
// returns a unique-violation and we keep the streak update we already made.

export type ApplyStreakOnCompletionInput = {
  userId: string;
  /** Pre-resolved profile timezone — passed in so the caller can batch reads. */
  timezone: string;
  /** Wall-clock instant the session finished. */
  now: Date;
  /** Optional session id used for the audit row on `streak_free_pass_uses`. */
  sessionId?: string;
};

export type ApplyStreakOnCompletionResult = StreakSnapshot & {
  bumped: boolean;
  freePassApplied: StreakUpdateDecision["freePass"];
  /** True if the user still has an unspent free-pass after this update. */
  freePassRemaining: boolean;
};

// Apply today's streak update for `userId`. Mirrors the contract of the old
// `bumpStreakForToday`: returns the post-update snapshot so the session-end
// summary can render it without another round-trip.
export async function applyStreakOnSessionCompletion(
  supabase: SupabaseClient<Database>,
  input: ApplyStreakOnCompletionInput,
): Promise<ApplyStreakOnCompletionResult> {
  const today = formatLocalDay(input.now, input.timezone);
  const monthKey = monthKeyFromLocalDate(today);

  const [existing, partner, freePassUsedThisMonth] = await Promise.all([
    readStreak(supabase, input.userId),
    readPartner(supabase, input.userId),
    hasFreePassUseThisMonth(supabase, input.userId, monthKey),
  ]);

  const decision = decideStreakUpdate({
    current: existing,
    now: input.now,
    timezone: input.timezone,
    partner,
    freePassUsedThisMonth,
  });

  // Persist the streak row regardless of whether the length actually
  // changed: we always want the row to exist after a session completion so
  // future reads have a base to work from. When the user already practised
  // today, `decision.next` equals the existing snapshot and the upsert is a
  // no-op on the user-visible columns.
  const { data: persisted, error } = await supabase
    .from("streaks")
    .upsert(
      {
        user_id: input.userId,
        current_length: decision.next.currentLength,
        longest_length: decision.next.longestLength,
        last_practiced_on: decision.next.lastPracticedOn,
        timezone: input.timezone,
      },
      { onConflict: "user_id" },
    )
    .select("current_length, longest_length, last_practiced_on")
    .maybeSingle();
  if (error) {
    // The session completion path absorbs streak-write errors — we'd rather
    // return the implied snapshot than fail the user-visible action.
    console.warn("streak upsert failed", error.message);
  }

  let tokenBurned = false;
  if (decision.freePass) {
    const { error: insertError } = await supabase.from("streak_free_pass_uses").insert({
      user_id: input.userId,
      month_key: decision.freePass.monthKey,
      applied_for_date: decision.freePass.appliedForDate,
      used_on: today,
      session_id: input.sessionId ?? null,
    });
    if (!insertError) {
      tokenBurned = true;
    } else if (!isUniqueViolation(insertError)) {
      // Unique violation is fine — another tab beat us to it. Any other
      // failure: log and continue; the streak is already persisted.
      console.warn("streak_free_pass_uses insert failed", insertError.message);
    }
  }

  const snapshot: StreakSnapshot = persisted
    ? {
        currentLength: persisted.current_length,
        longestLength: persisted.longest_length,
        lastPracticedOn: persisted.last_practiced_on,
      }
    : decision.next;

  return {
    ...snapshot,
    bumped: decision.bumped,
    freePassApplied: tokenBurned ? decision.freePass : null,
    freePassRemaining: !(freePassUsedThisMonth || tokenBurned),
  };
}

// Reads the user's streak row, returning null when it does not exist yet.
export async function readStreak(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<StreakSnapshot | null> {
  const { data } = await supabase
    .from("streaks")
    .select("current_length, longest_length, last_practiced_on")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return null;
  return {
    currentLength: data.current_length,
    longestLength: data.longest_length,
    lastPracticedOn: data.last_practiced_on,
  };
}

// Loads the partner's streak row, scoped to the same household. Returns
// null in solo households so the pure decision treats the partner check as
// vacuously satisfied.
async function readPartner(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<StreakPartnerInput | null> {
  const { data: self } = await supabase
    .from("profiles")
    .select("household_id")
    .eq("id", userId)
    .maybeSingle();
  if (!self?.household_id) return null;

  const { data: members } = await supabase
    .from("profiles")
    .select("id, timezone")
    .eq("household_id", self.household_id)
    .neq("id", userId)
    .limit(1);
  const partner = members?.[0];
  if (!partner) return null;

  const { data: streak } = await supabase
    .from("streaks")
    .select("last_practiced_on")
    .eq("user_id", partner.id)
    .maybeSingle();
  return {
    lastPracticedOn: streak?.last_practiced_on ?? null,
    timezone: partner.timezone,
  };
}

export async function hasFreePassUseThisMonth(
  supabase: SupabaseClient<Database>,
  userId: string,
  monthKey: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("streak_free_pass_uses")
    .select("month_key")
    .eq("user_id", userId)
    .eq("month_key", monthKey)
    .maybeSingle();
  return data !== null;
}

function isUniqueViolation(error: { code?: string | null }): boolean {
  return error.code === "23505";
}
