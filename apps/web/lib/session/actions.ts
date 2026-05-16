"use server";

import { z } from "zod";
import {
  CORRECTION_DRILL_XP_PER_PASS,
  CorrectionDrillResultSchema,
  gradeRetypeAttempt,
  nextDrillSchedule,
  type CorrectionDrillResult,
} from "@reverb/domain/schemas/correction-drill";
import { requireUser } from "@/lib/auth/get-user";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  completeSession,
  recordSessionItemAnswer,
  startOrResumeTodaysSession,
  type CompleteSessionResult,
  type DailySessionView,
} from "@/lib/session/orchestrator";
import { SHADOWING_XP_PER_PASS } from "@/lib/session/shadowing";

export type RecordDrillAttemptInput = {
  drillId: string;
  mode: "retype" | "self_mark";
  // For retype mode the user types the correction. For self_mark mode the
  // client passes a CorrectionDrillResult directly.
  userResponse?: string;
  selfMarked?: CorrectionDrillResult;
  responseMs?: number;
  // Optional session-item link. When provided, recording the answer also
  // updates the practice_session_items row + the session counters + the
  // practice_events log. Outside-of-session drills (a future "extra
  // practice" entry point) just omit this and the session bookkeeping is
  // skipped.
  sessionItemId?: string;
};

export type RecordDrillAttemptResult =
  | {
      ok: true;
      result: CorrectionDrillResult;
      retired: boolean;
      nextDueAt: string;
      xpAwarded: number;
      totalXp: number;
      // Session counters, set when `sessionItemId` was passed in. The UI
      // uses these to render live progress without a refetch.
      session?: {
        sessionItemId: string;
        sessionXpEarned: number;
        cardsReviewed: number;
        exercisesAttempted: number;
      };
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
    user_response: input.mode === "retype" ? (input.userResponse ?? null) : null,
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

  // Intentionally no revalidatePath here: SessionRunner stays mounted
  // across answers, and a mid-batch refetch would drop the just-answered
  // item from its `view.items` snapshot, shifting the runner's index off-
  // by-one. /session is `dynamic = "force-dynamic"`, so the next full
  // page visit fetches fresh data anyway.

  type SessionSnapshot = {
    sessionItemId: string;
    sessionXpEarned: number;
    cardsReviewed: number;
    exercisesAttempted: number;
  };
  let sessionSnapshot: SessionSnapshot | undefined;
  // Mistake drills are "exercise" bucket — they count toward
  // exercises_attempted, not cards_reviewed. We only record a session item
  // when the caller passed one in; outside-of-session use stays a single
  // round-trip.
  if (input.sessionItemId) {
    try {
      const recorded = await recordSessionItemAnswer(supabase, user.id, {
        sessionItemId: input.sessionItemId,
        correct: result === "pass",
        rating: null,
        responseMs: input.responseMs ?? null,
        xpAwarded,
        bucket: "exercise",
      });
      sessionSnapshot = {
        sessionItemId: input.sessionItemId,
        sessionXpEarned: recorded.sessionXpEarned,
        cardsReviewed: recorded.cardsReviewed,
        exercisesAttempted: recorded.exercisesAttempted,
      };
    } catch (sessionError) {
      // The drill answer is already persisted — don't bubble the error to
      // the user as a failed attempt. Log it so a follow-up can rebuild the
      // session counters offline if it matters.
      console.warn(
        "recordSessionItemAnswer failed for drill",
        sessionError instanceof Error ? sessionError.message : sessionError,
      );
    }
  }

  return {
    ok: true,
    result,
    retired: schedule.retire,
    nextDueAt: schedule.nextDueAt.toISOString(),
    xpAwarded,
    totalXp: nextXp,
    session: sessionSnapshot,
  };
}

export type StartTodaysSessionResult =
  | { ok: true; session: DailySessionView }
  | { ok: false; error: string };

// Server-action wrapper around the orchestrator. Used by the home page's
// "Start Today's Session" CTA when we want the action surface (and the
// resulting session id) without rendering `/session` first.
export async function startTodaysSessionAction(): Promise<StartTodaysSessionResult> {
  const user = await requireUser();
  const supabase = await createServerSupabaseClient();
  if (!supabase) {
    return { ok: false, error: "Supabase is not configured for this environment." };
  }
  try {
    const session = await startOrResumeTodaysSession(supabase, user.id);
    return { ok: true, session };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unexpected error." };
  }
}

const ShadowingResultSchema = z.enum(["got_it", "try_again"]);
export type ShadowingSelfMarkResult = z.infer<typeof ShadowingResultSchema>;

const RecordShadowingAttemptInputSchema = z.object({
  sessionItemId: z.string().uuid(),
  dialogueClipId: z.string().uuid(),
  result: ShadowingResultSchema,
  // We don't persist recordings client-side, but the duration is useful for
  // event payload + future analytics ("user actually attempted vs. only
  // listened").
  recordingMs: z.number().int().nonnegative().max(60_000).optional(),
  responseMs: z
    .number()
    .int()
    .nonnegative()
    .max(60 * 60_000)
    .optional(),
  // True if the user's browser didn't support MediaRecorder or denied
  // permission. We still let them self-mark so a session can finish; the
  // event payload tags this so we can spot environments that aren't gating
  // shadowing properly.
  fallback: z.boolean().optional(),
});

export type RecordShadowingAttemptInput = z.infer<typeof RecordShadowingAttemptInputSchema>;

export type RecordShadowingAttemptResult =
  | {
      ok: true;
      result: ShadowingSelfMarkResult;
      xpAwarded: number;
      session: {
        sessionItemId: string;
        sessionXpEarned: number;
        cardsReviewed: number;
        exercisesAttempted: number;
      };
    }
  | { ok: false; error: string };

// Records a single shadowing self-mark. The MediaRecorder blob never reaches
// the server — only the user's pass/fail call does. We mirror the drill
// action's contract so SessionRunner can advance the queue with the same
// `onAnswered` snapshot shape it already consumes for vocab + drills.
export async function recordShadowingAttempt(
  input: RecordShadowingAttemptInput,
): Promise<RecordShadowingAttemptResult> {
  const parsed = RecordShadowingAttemptInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Invalid shadowing attempt." };
  }

  const user = await requireUser();
  const supabase = await createServerSupabaseClient();
  if (!supabase) {
    return { ok: false, error: "Supabase is not configured for this environment." };
  }

  const passed = parsed.data.result === "got_it";
  const xpAwarded = passed ? SHADOWING_XP_PER_PASS : 0;

  try {
    const recorded = await recordSessionItemAnswer(supabase, user.id, {
      sessionItemId: parsed.data.sessionItemId,
      correct: passed,
      rating: null,
      responseMs: parsed.data.responseMs ?? null,
      xpAwarded,
      bucket: "exercise",
      eventKind: "item_answered",
      eventPayload: {
        item_type: "shadowing",
        dialogue_clip_id: parsed.data.dialogueClipId,
        self_marked: parsed.data.result,
        recording_ms: parsed.data.recordingMs ?? null,
        fallback: parsed.data.fallback ?? false,
      },
    });
    return {
      ok: true,
      result: parsed.data.result,
      xpAwarded,
      session: {
        sessionItemId: parsed.data.sessionItemId,
        sessionXpEarned: recorded.sessionXpEarned,
        cardsReviewed: recorded.cardsReviewed,
        exercisesAttempted: recorded.exercisesAttempted,
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unexpected error." };
  }
}

export type CompleteSessionActionResult =
  | { ok: true; summary: CompleteSessionResult }
  | { ok: false; error: string };

// Server action the SessionRunner calls after the last item is answered.
// Wraps `completeSession` so the UI can show the XP-earned + streak summary
// without an extra page load.
export async function completeSessionAction(input: {
  sessionId: string;
}): Promise<CompleteSessionActionResult> {
  const user = await requireUser();
  const supabase = await createServerSupabaseClient();
  if (!supabase) {
    return { ok: false, error: "Supabase is not configured for this environment." };
  }
  try {
    const summary = await completeSession(supabase, user.id, input.sessionId);
    return { ok: true, summary };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Unexpected error." };
  }
}
