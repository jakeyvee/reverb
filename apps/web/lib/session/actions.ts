"use server";

import {
  CORRECTION_DRILL_XP_PER_PASS,
  CorrectionDrillResultSchema,
  gradeRetypeAttempt,
  nextDrillSchedule,
  type CorrectionDrillResult,
} from "@reverb/domain/schemas/correction-drill";
import { requireUser } from "@/lib/auth/get-user";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export type RecordDrillAttemptInput = {
  drillId: string;
  mode: "retype" | "self_mark";
  // For retype mode the user types the correction. For self_mark mode the
  // client passes a CorrectionDrillResult directly.
  userResponse?: string;
  selfMarked?: CorrectionDrillResult;
  responseMs?: number;
};

export type RecordDrillAttemptResult =
  | {
      ok: true;
      result: CorrectionDrillResult;
      retired: boolean;
      nextDueAt: string;
      xpAwarded: number;
      totalXp: number;
    }
  | { ok: false; error: string };

// Records a single drill attempt:
//   1. Loads the drill row (RLS-scoped to the caller).
//   2. Grades it — exact-match for retype, trusts the client for self-mark.
//   3. Inserts a row in correction_drill_attempts (audit log).
//   4. Updates the drill state, counters, due_at, and xp_earned.
//
// We let RLS do the user-scoping. If the drill belongs to another user the
// initial select returns null and we bail before touching anything.
export async function recordCorrectionDrillAttempt(
  input: RecordDrillAttemptInput,
): Promise<RecordDrillAttemptResult> {
  const user = await requireUser();
  const supabase = await createServerSupabaseClient();
  if (!supabase) {
    return { ok: false, error: "Supabase is not configured for this environment." };
  }

  const { data: drill, error: drillError } = await supabase
    .from("correction_drills")
    .select(
      "id, state, attempts, passes, fails, consecutive_passes, xp_earned, teacher_correction:teacher_corrections!inner(corrected_text, confidence)",
    )
    .eq("id", input.drillId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (drillError) {
    return { ok: false, error: drillError.message };
  }
  if (!drill) {
    return { ok: false, error: "Drill not found." };
  }
  if (drill.state === "retired") {
    return { ok: false, error: "Drill is retired." };
  }
  const correction = Array.isArray(drill.teacher_correction)
    ? drill.teacher_correction[0]
    : drill.teacher_correction;
  if (!correction) {
    return { ok: false, error: "Drill correction not found." };
  }

  let result: CorrectionDrillResult;
  if (input.mode === "retype") {
    const typed = (input.userResponse ?? "").trim();
    if (typed.length === 0) {
      return { ok: false, error: "Please type the correction before submitting." };
    }
    result = gradeRetypeAttempt({
      expected: correction.corrected_text,
      actual: typed,
    });
  } else {
    const parsed = CorrectionDrillResultSchema.safeParse(input.selfMarked);
    if (!parsed.success) {
      return { ok: false, error: "Invalid self-mark result." };
    }
    result = parsed.data;
  }

  const xpAwarded = result === "pass" ? CORRECTION_DRILL_XP_PER_PASS : 0;
  const now = new Date();

  const schedule = nextDrillSchedule({
    consecutivePasses: drill.consecutive_passes,
    result,
    now,
  });

  const { error: insertError } = await supabase.from("correction_drill_attempts").insert({
    drill_id: drill.id,
    user_id: user.id,
    result,
    response_ms: input.responseMs ?? null,
    xp_awarded: xpAwarded,
    user_response: input.mode === "retype" ? input.userResponse ?? null : null,
    attempted_at: now.toISOString(),
  });
  if (insertError) {
    return { ok: false, error: insertError.message };
  }

  const nextXp = drill.xp_earned + xpAwarded;
  const { error: updateError } = await supabase
    .from("correction_drills")
    .update({
      state: schedule.nextState,
      due_at: schedule.nextDueAt.toISOString(),
      attempts: drill.attempts + 1,
      passes: drill.passes + (result === "pass" ? 1 : 0),
      fails: drill.fails + (result === "fail" ? 1 : 0),
      consecutive_passes: schedule.nextConsecutivePasses,
      last_result: result,
      last_attempted_at: now.toISOString(),
      retired_at: schedule.retire ? now.toISOString() : null,
      xp_earned: nextXp,
    })
    .eq("id", drill.id)
    .eq("user_id", user.id);
  if (updateError) {
    return { ok: false, error: updateError.message };
  }

  // Intentionally no revalidatePath here: the MistakeDrillRunner stays mounted
  // across answers, and a mid-batch refetch would drop the just-answered drill
  // from the `drills` prop, shifting the runner's index off-by-one and skipping
  // the next drill. /session is `dynamic = "force-dynamic"`, so the next page
  // visit fetches fresh data anyway.
  return {
    ok: true,
    result,
    retired: schedule.retire,
    nextDueAt: schedule.nextDueAt.toISOString(),
    xpAwarded,
    totalXp: nextXp,
  };
}
