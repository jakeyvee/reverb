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
import {
  LISTENING_PROMPT_KINDS,
  gradeListeningTranscription,
  parseListeningPromptFromMetadata,
  type ListeningPromptKind,
} from "@/lib/session/listening-comprehension";

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

// ---- Listening comprehension --------------------------------------------

// XP awarded for a correct listening answer. Lower than vocab/correction
// passes because the snippet is shorter and the question type rotates —
// we want it to feel rewarding without crowding out the SRS-driven kinds.
// Kept module-private because "use server" forbids non-async exports.
const LISTENING_XP_PER_CORRECT = 2;

const ListeningAttemptInputSchema = z.object({
  sessionItemId: z.string().uuid(),
  promptKind: z.enum(LISTENING_PROMPT_KINDS),
  // Free-text typed answer for the transcription mode. Used by both the
  // automatic grader and the (optional) self-mark fallback.
  typedAnswer: z.string().optional(),
  // 0-based index into the persisted choices array for MC modes.
  selectedIndex: z.number().int().nonnegative().optional(),
  // Self-mark override: when the client passes this, we trust the user's
  // own assessment (mainly for transcription "close enough" path).
  selfMarked: z.enum(["pass", "fail"]).optional(),
  responseMs: z.number().int().nonnegative().optional(),
});

export type RecordListeningAttemptInput = z.infer<typeof ListeningAttemptInputSchema>;

export type RecordListeningAttemptResult =
  | {
      ok: true;
      correct: boolean;
      xpAwarded: number;
      // The canonical answer for the question type, surfaced back so the
      // UI can show "the speaker said …" or "the correct meaning was …"
      // without re-deriving it client-side.
      expected: {
        promptKind: ListeningPromptKind;
        text: string | null;
        choiceIndex: number | null;
      };
      session?: {
        sessionItemId: string;
        sessionXpEarned: number;
        cardsReviewed: number;
        exercisesAttempted: number;
      };
    }
  | { ok: false; error: string };

export async function recordListeningAttempt(
  input: RecordListeningAttemptInput,
): Promise<RecordListeningAttemptResult> {
  const parsed = ListeningAttemptInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Invalid request." };
  }
  const user = await requireUser();
  const supabase = await createServerSupabaseClient();
  if (!supabase) {
    return { ok: false, error: "Supabase is not configured for this environment." };
  }

  const { data: item, error: itemError } = await supabase
    .from("practice_session_items")
    .select("id, kind, metadata, answered_at")
    .eq("id", parsed.data.sessionItemId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (itemError) {
    return { ok: false, error: itemError.message };
  }
  if (!item) {
    return { ok: false, error: "Session item not found." };
  }
  if (item.kind !== "dialogue_clip") {
    return { ok: false, error: "Session item is not a listening exercise." };
  }
  const prompt = parseListeningPromptFromMetadata(item.metadata);
  if (!prompt) {
    return { ok: false, error: "Listening prompt is missing or malformed." };
  }
  if (prompt.kind !== parsed.data.promptKind) {
    return { ok: false, error: "Prompt kind mismatch." };
  }

  let correct = false;
  if (parsed.data.selfMarked) {
    correct = parsed.data.selfMarked === "pass";
  } else if (prompt.kind === "transcription") {
    const actual = parsed.data.typedAnswer ?? "";
    if (actual.trim().length === 0) {
      return { ok: false, error: "Type what you heard before submitting." };
    }
    const expected = prompt.expectedText ?? "";
    correct = gradeListeningTranscription({ expected, actual }) === "pass";
  } else {
    const selected = parsed.data.selectedIndex;
    if (selected === undefined) {
      return { ok: false, error: "Pick an answer before submitting." };
    }
    if (selected < 0 || selected >= prompt.choices.length) {
      return { ok: false, error: "Selected answer is out of range." };
    }
    correct = selected === prompt.answerIndex;
  }

  const xpAwarded = correct ? LISTENING_XP_PER_CORRECT : 0;

  let sessionSnapshot: Extract<RecordListeningAttemptResult, { ok: true }>["session"];
  try {
    const recorded = await recordSessionItemAnswer(supabase, user.id, {
      sessionItemId: parsed.data.sessionItemId,
      correct,
      rating: null,
      responseMs: parsed.data.responseMs ?? null,
      xpAwarded,
      bucket: "exercise",
      eventPayload: {
        listening: {
          prompt_kind: prompt.kind,
          self_marked: parsed.data.selfMarked ?? null,
          selected_index: parsed.data.selectedIndex ?? null,
          typed_answer_length: parsed.data.typedAnswer?.length ?? null,
        },
      },
    });
    sessionSnapshot = {
      sessionItemId: parsed.data.sessionItemId,
      sessionXpEarned: recorded.sessionXpEarned,
      cardsReviewed: recorded.cardsReviewed,
      exercisesAttempted: recorded.exercisesAttempted,
    };
  } catch (sessionError) {
    return {
      ok: false,
      error: sessionError instanceof Error ? sessionError.message : "Unexpected error.",
    };
  }

  return {
    ok: true,
    correct,
    xpAwarded,
    expected: {
      promptKind: prompt.kind,
      text: prompt.expectedText,
      choiceIndex: prompt.answerIndex,
    },
    session: sessionSnapshot,
  };
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
