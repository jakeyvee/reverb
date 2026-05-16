"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { inferScenarioWithAnthropic } from "@reverb/ai";
import {
  ChatLevelSchema,
  SCENARIO_COMPLETION_XP,
  SCENARIO_MAX_USER_TURNS,
  SCENARIO_USER_MESSAGE_MAX_CHARS,
  ScenarioIdSchema,
  type ScenarioCorrection,
  type ScenarioId,
  type ScenarioLevel,
  getScenarioDefinition,
} from "@reverb/domain";
import type { TablesInsert } from "@reverb/db/types";
import { requireUser } from "@/lib/auth/get-user";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  buildScenarioConversationContext,
  getOrCreateActiveScenarioSession,
  getScenarioSession,
  loadScenarioMessages,
  toScenarioTurns,
  type ScenarioHistoryMessage,
} from "./sessions";

// VOL-133: Server actions for travel scenario role-play.
//
// Mirrors the chat partner's send/start-over flow (lib/chat/actions.ts) but
// adds two scenario-specific moves:
//   - `startScenarioAction`        — open / resume an active session for a
//                                    given scenario id (idempotent).
//   - `completeScenarioAction`     — finalise an active session, award the
//                                    flat SCENARIO_COMPLETION_XP, and emit a
//                                    `practice_events` row tagged as
//                                    `source: "scenario"`.
//   - `abandonScenarioAction`      — user-driven exit. Marks the row as
//                                    abandoned without awarding XP.
//
// Persistence runs *after* the AI call so a failed completion never leaves
// an orphan user turn on the transcript — matching the chat action pattern.

const StartInputSchema = z.object({
  scenarioId: ScenarioIdSchema,
  level: ChatLevelSchema.optional(),
});

export type StartScenarioInput = z.infer<typeof StartInputSchema>;

export type StartScenarioResult =
  | { ok: true; sessionId: string; scenarioId: ScenarioId; level: ScenarioLevel }
  | { ok: false; error: string };

export async function startScenarioAction(input: StartScenarioInput): Promise<StartScenarioResult> {
  const parsed = StartInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid request." };
  }
  const user = await requireUser();
  const supabase = await createServerSupabaseClient();
  if (!supabase) {
    return { ok: false, error: "Supabase is not configured for this environment." };
  }
  try {
    const session = await getOrCreateActiveScenarioSession(
      supabase,
      user.id,
      parsed.data.scenarioId,
      parsed.data.level ?? "beginner",
    );
    return {
      ok: true,
      sessionId: session.id,
      scenarioId: parsed.data.scenarioId,
      level: normaliseLevel(session.level),
    };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

const SendInputSchema = z.object({
  sessionId: z.string().uuid(),
  message: z
    .string()
    .min(1, "Message is empty.")
    .max(
      SCENARIO_USER_MESSAGE_MAX_CHARS,
      `Message exceeds ${SCENARIO_USER_MESSAGE_MAX_CHARS} characters.`,
    ),
});

export type SendScenarioMessageInput = z.infer<typeof SendInputSchema>;

export type SendScenarioMessageResult =
  | {
      ok: true;
      sessionId: string;
      userMessage: ScenarioHistoryMessage;
      assistantMessage: ScenarioHistoryMessage;
      sceneComplete: boolean;
      // Surface the user-turn cap so the UI can show "X / SCENARIO_MAX_USER_TURNS".
      userTurnCount: number;
    }
  | { ok: false; error: string };

export async function sendScenarioMessageAction(
  input: SendScenarioMessageInput,
): Promise<SendScenarioMessageResult> {
  const parsed = SendInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid request." };
  }
  const user = await requireUser();
  const supabase = await createServerSupabaseClient();
  if (!supabase) {
    return { ok: false, error: "Supabase is not configured for this environment." };
  }

  let session;
  try {
    session = await getScenarioSession(supabase, parsed.data.sessionId, user.id);
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
  if (!session) {
    return { ok: false, error: "Scenario session not found." };
  }
  if (session.status !== "active") {
    return { ok: false, error: "This scenario session has already ended." };
  }
  if (session.total_user_messages >= SCENARIO_MAX_USER_TURNS) {
    return {
      ok: false,
      error: "You've reached this scenario's turn limit — finish the scene to claim XP.",
    };
  }

  const trimmedMessage = parsed.data.message.trim();
  if (trimmedMessage.length === 0) {
    return { ok: false, error: "Message is empty." };
  }

  let priorMessages: ScenarioHistoryMessage[];
  try {
    priorMessages = await loadScenarioMessages(supabase, session.id, user.id);
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }

  let context;
  try {
    context = await buildScenarioConversationContext(supabase, user.id, session);
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }

  let inference;
  try {
    inference = await inferScenarioWithAnthropic({
      context,
      history: toScenarioTurns(priorMessages),
      userMessage: trimmedMessage,
      // The persona's opening line is rendered client-side as the first
      // assistant bubble but is NOT persisted as a row — we let the adapter
      // re-seed it when history is empty so the model has scene context on
      // the first user turn.
      seedOpening: priorMessages.length === 0,
    });
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }

  const userMessageRow: TablesInsert<"scenario_messages"> = {
    session_id: session.id,
    user_id: user.id,
    role: "user",
    content: trimmedMessage,
    language: "id",
    metadata: { client_submitted_at: new Date().toISOString() },
  };
  const { data: userInserted, error: userInsertError } = await supabase
    .from("scenario_messages")
    .insert(userMessageRow)
    .select("*")
    .single();
  if (userInsertError || !userInserted) {
    return {
      ok: false,
      error: `Could not save user message: ${userInsertError?.message ?? "missing"}`,
    };
  }

  const assistantRow: TablesInsert<"scenario_messages"> = {
    session_id: session.id,
    user_id: user.id,
    role: "assistant",
    content: inference.response.reply,
    language: inference.response.replyLanguage,
    metadata: {
      model: inference.model,
      prompt_version: inference.promptVersion,
      raw_response: inference.rawResponse,
      scene_complete: inference.response.sceneComplete,
    },
  };
  const { data: assistantInserted, error: assistantInsertError } = await supabase
    .from("scenario_messages")
    .insert(assistantRow)
    .select("*")
    .single();
  if (assistantInsertError || !assistantInserted) {
    return {
      ok: false,
      error: `Could not save assistant message: ${assistantInsertError?.message ?? "missing"}`,
    };
  }

  const corrections: ScenarioCorrection[] = inference.response.corrections;
  if (corrections.length > 0) {
    const correctionRows: TablesInsert<"scenario_corrections">[] = corrections.map((c) => ({
      message_id: userInserted.id,
      session_id: session.id,
      user_id: user.id,
      kind: c.kind,
      source_text: c.sourceText,
      corrected_text: c.correctedText,
      explanation: c.explanation ?? null,
    }));
    const { error: correctionInsertError } = await supabase
      .from("scenario_corrections")
      .insert(correctionRows);
    if (correctionInsertError) {
      return {
        ok: false,
        error: `Could not save scenario corrections: ${correctionInsertError.message}`,
      };
    }
  }

  const { error: bumpError } = await supabase.rpc("bump_scenario_session_counters", {
    p_session_id: session.id,
    p_message_increment: 2,
    p_user_message_increment: 1,
  });
  if (bumpError) {
    return { ok: false, error: `Could not update scenario session: ${bumpError.message}` };
  }

  return {
    ok: true,
    sessionId: session.id,
    userMessage: {
      id: userInserted.id,
      role: "user",
      content: userInserted.content,
      language: userInserted.language,
      createdAt: userInserted.created_at,
      corrections,
    },
    assistantMessage: {
      id: assistantInserted.id,
      role: "assistant",
      content: assistantInserted.content,
      language: assistantInserted.language,
      createdAt: assistantInserted.created_at,
      corrections: [],
    },
    sceneComplete: inference.response.sceneComplete,
    userTurnCount: session.total_user_messages + 1,
  };
}

const CompleteInputSchema = z.object({
  sessionId: z.string().uuid(),
});

export type CompleteScenarioInput = z.infer<typeof CompleteInputSchema>;

export type CompleteScenarioResult =
  | {
      ok: true;
      sessionId: string;
      status: "completed" | "already_completed";
      xpAwarded: number;
      totalXp: number;
    }
  | { ok: false; error: string };

// Finalises a scenario session.
//
// The user-visible "+10 XP" claim and the `practice_events` row that drives
// downstream telemetry must stay in sync — earlier this action flipped the
// session to `completed` first and treated the practice_events insert as
// best-effort, which meant a transient telemetry failure left the user
// thinking they had earned XP that the home / weekly readouts never saw,
// with no retry path (the `already_completed` branch short-circuited
// before the event row was even attempted).
//
// Order of operations now:
//   1. Verify ownership, scene-was-actually-played, and session state.
//   2. Look up an existing `practice_events` row keyed by
//      `payload.scenario_session_id`. We use jsonb containment so retries
//      don't double-write.
//   3. If there is no event row, insert one. On failure we return an error
//      and leave the session active so the user can retry — the click on
//      "Finish & claim XP" then re-enters this action and writes the row.
//   4. Only after the event has landed do we flip the session row to
//      `completed` + bump `xp_earned`. On the rare update failure the
//      event row already exists, so the next retry detects it via (2) and
//      skips straight to the update.
//
// `already_completed` therefore means both rows are durable: the session
// is `completed` *and* the matching telemetry row exists.
export async function completeScenarioAction(
  input: CompleteScenarioInput,
): Promise<CompleteScenarioResult> {
  const parsed = CompleteInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid request." };
  }
  const user = await requireUser();
  const supabase = await createServerSupabaseClient();
  if (!supabase) {
    return { ok: false, error: "Supabase is not configured for this environment." };
  }

  const session = await getScenarioSession(supabase, parsed.data.sessionId, user.id);
  if (!session) {
    return { ok: false, error: "Scenario session not found." };
  }
  if (session.status !== "active" && session.status !== "completed") {
    return { ok: false, error: "This scenario session has already ended." };
  }
  if (session.total_user_messages === 0) {
    return {
      ok: false,
      error: "Practice the scenario first — at least one reply is required to claim XP.",
    };
  }

  const now = new Date();
  const alreadyCompleted = session.status === "completed";

  // (2) Has a completion event already landed for this scenario session?
  // The jsonb containment filter (`@>`) matches any row whose payload
  // includes the given key/value pair, which is the same shape we insert
  // below — so a retry after a half-completed run finds the prior insert
  // and we don't write a duplicate. Returning `id` rather than `head` keeps
  // the row count cheap (PostgREST limits to one).
  const { data: existingEvents, error: existingEventsError } = await supabase
    .from("practice_events")
    .select("id")
    .eq("user_id", user.id)
    .eq("kind", "session_complete")
    .contains("payload", { scenario_session_id: session.id })
    .limit(1);
  if (existingEventsError) {
    return {
      ok: false,
      error: `Could not check scenario events: ${existingEventsError.message}`,
    };
  }
  const eventExists = (existingEvents ?? []).length > 0;

  if (!eventExists) {
    const definition = (() => {
      try {
        return getScenarioDefinition(ScenarioIdSchema.parse(session.scenario_id));
      } catch {
        return null;
      }
    })();
    const eventRow: TablesInsert<"practice_events"> = {
      user_id: user.id,
      session_id: null,
      session_item_id: null,
      kind: "session_complete",
      occurred_at: now.toISOString(),
      payload: {
        source: "scenario",
        scenario_session_id: session.id,
        scenario_id: session.scenario_id,
        scenario_title: definition?.title ?? null,
        xp_awarded: SCENARIO_COMPLETION_XP,
        user_turns: session.total_user_messages,
      },
    };
    const { error: eventError } = await supabase.from("practice_events").insert(eventRow);
    if (eventError) {
      // Bubble up so the runner can re-trigger; the session stays active
      // (or already-completed) and a retry re-enters this branch.
      return {
        ok: false,
        error: `Could not record scenario completion: ${eventError.message}`,
      };
    }
  }

  // (4) Flip the session row. Idempotent: already-completed sessions just
  // skip the update and report the existing xp_earned.
  if (!alreadyCompleted) {
    const { error: updateError } = await supabase
      .from("scenario_sessions")
      .update({
        status: "completed",
        completed_at: now.toISOString(),
        xp_earned: SCENARIO_COMPLETION_XP,
      })
      .eq("id", session.id)
      .eq("user_id", user.id);
    if (updateError) {
      // The event row landed (either just now or on a prior attempt). The
      // next retry will detect that via the containment query above and
      // skip straight to this update.
      return { ok: false, error: `Could not complete scenario: ${updateError.message}` };
    }
  }

  revalidatePath("/scenarios");

  return {
    ok: true,
    sessionId: session.id,
    status: alreadyCompleted ? "already_completed" : "completed",
    xpAwarded: alreadyCompleted ? 0 : SCENARIO_COMPLETION_XP,
    totalXp: alreadyCompleted ? session.xp_earned : SCENARIO_COMPLETION_XP,
  };
}

const AbandonInputSchema = z.object({
  sessionId: z.string().uuid(),
});

export type AbandonScenarioInput = z.infer<typeof AbandonInputSchema>;
export type AbandonScenarioResult = { ok: true } | { ok: false; error: string };

// User-driven exit. Marks the active row as abandoned so re-entering the
// same scenario opens a fresh row. A completed or already-abandoned row is
// treated as a no-op rather than an error — the button is a single visible
// affordance and we don't want a double-click to fail.
export async function abandonScenarioAction(
  input: AbandonScenarioInput,
): Promise<AbandonScenarioResult> {
  const parsed = AbandonInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid request." };
  }
  const user = await requireUser();
  const supabase = await createServerSupabaseClient();
  if (!supabase) {
    return { ok: false, error: "Supabase is not configured for this environment." };
  }
  const session = await getScenarioSession(supabase, parsed.data.sessionId, user.id);
  if (!session) {
    return { ok: false, error: "Scenario session not found." };
  }
  if (session.status !== "active") {
    revalidatePath("/scenarios");
    return { ok: true };
  }
  const now = new Date();
  const { error } = await supabase
    .from("scenario_sessions")
    .update({
      status: "abandoned",
      abandoned_at: now.toISOString(),
    })
    .eq("id", session.id)
    .eq("user_id", user.id);
  if (error) {
    return { ok: false, error: `Could not exit scenario: ${error.message}` };
  }
  revalidatePath("/scenarios");
  return { ok: true };
}

function normaliseLevel(value: string): ScenarioLevel {
  if (value === "intermediate" || value === "advanced") return value;
  return "beginner";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error.";
}
