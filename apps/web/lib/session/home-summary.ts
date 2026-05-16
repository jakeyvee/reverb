import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@reverb/db/types";

// Lightweight read-only snapshot used by the home tile. We do NOT call the
// orchestrator's `startOrResumeTodaysSession` from here because that would
// create a practice_sessions row just by visiting /. Instead we:
//   1. Look for an active session today and report its open-item counts.
//   2. If none exists, peek at candidate counts (due correction drills +
//      due vocab cards) so the tile can hint at what's queued without
//      committing the user to a session.
//
// The estimate is a rough heuristic: ~30 seconds per item, ceil to the
// nearest minute, capped at 30. It's a budgeting cue, not a clock.

const SECONDS_PER_ITEM = 30;
const MAX_ESTIMATE_MINUTES = 30;

export type DailySessionSummary = {
  status: "active" | "completed" | "no-session";
  newCount: number;
  dueCount: number;
  estimateMinutes: number | null;
};

export async function loadDailySessionSummary(
  supabase: SupabaseClient<Database>,
  userId: string,
  now: Date = new Date(),
): Promise<DailySessionSummary> {
  const dayStart = startOfUtcDay(now).toISOString();
  const dayEnd = endOfUtcDay(now).toISOString();
  const nowIso = now.toISOString();

  const { data: existing, error: existingError } = await supabase
    .from("practice_sessions")
    .select("id, status")
    .eq("user_id", userId)
    .gte("started_at", dayStart)
    .lt("started_at", dayEnd)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingError) {
    throw new Error(`Could not load daily session summary: ${existingError.message}`);
  }

  if (existing?.status === "active") {
    // Already started today — report the items still open in this session.
    const { data: itemRows, error: itemsError } = await supabase
      .from("practice_session_items")
      .select("kind, answered_at")
      .eq("session_id", existing.id)
      .eq("user_id", userId);
    if (itemsError) {
      throw new Error(`Could not load active session items: ${itemsError.message}`);
    }
    const open = (itemRows ?? []).filter((row) => row.answered_at === null);
    const newCount = open.filter((row) => row.kind === "card").length;
    const dueCount = open.filter((row) => row.kind === "mistake_drill").length;
    return {
      status: "active",
      newCount,
      dueCount,
      estimateMinutes: estimateMinutes(newCount + dueCount),
    };
  }

  if (existing?.status === "completed") {
    return {
      status: "completed",
      newCount: 0,
      dueCount: 0,
      estimateMinutes: null,
    };
  }

  // No session yet today — peek at the orchestrator's candidate counts so
  // the tile can show what the user would get if they tapped Start.
  const [{ count: drillCount }, { count: cardCount }] = await Promise.all([
    supabase
      .from("correction_drills")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .neq("state", "retired")
      .lte("due_at", nowIso),
    supabase
      .from("cards")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .lte("due_at", nowIso),
  ]);

  const drills = drillCount ?? 0;
  const cards = cardCount ?? 0;
  return {
    status: "no-session",
    newCount: cards,
    dueCount: drills,
    estimateMinutes: estimateMinutes(cards + drills),
  };
}

function estimateMinutes(itemCount: number): number | null {
  if (itemCount <= 0) return null;
  const seconds = itemCount * SECONDS_PER_ITEM;
  return Math.min(MAX_ESTIMATE_MINUTES, Math.max(1, Math.ceil(seconds / 60)));
}

function startOfUtcDay(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function endOfUtcDay(now: Date): Date {
  const d = startOfUtcDay(now);
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}
