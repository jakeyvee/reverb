"use server";

import { z } from "zod";
import {
  ANTHROPIC_CONVERSATION_PROVIDER_ID,
  estimateCostMicroUsd,
  inferConversationWithAnthropic,
} from "@reverb/ai";
import {
  CHAT_HISTORY_WINDOW,
  CHAT_USER_MESSAGE_MAX_CHARS,
  ChatLevelSchema,
  type ChatCorrection,
  type ChatLevel,
} from "@reverb/domain";
import { createServiceRoleClient } from "@reverb/db/server";
import type { TablesInsert } from "@reverb/db/types";
import { createProviderUsageRecorder } from "@reverb/db/usage";
import { requireUser } from "@/lib/auth/get-user";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  buildConversationContext,
  getOrCreateActiveSession,
  loadSessionMessages,
  startNewSession,
  toChatTurns,
  type ChatHistoryMessage,
} from "./sessions";

const SendInputSchema = z.object({
  sessionId: z.string().uuid().optional(),
  message: z
    .string()
    .min(1, "Message is empty.")
    .max(CHAT_USER_MESSAGE_MAX_CHARS, `Message exceeds ${CHAT_USER_MESSAGE_MAX_CHARS} characters.`),
  level: ChatLevelSchema.optional(),
});

export type SendChatMessageInput = z.infer<typeof SendInputSchema>;

export type SendChatMessageResult =
  | {
      ok: true;
      sessionId: string;
      userMessage: ChatHistoryMessage;
      assistantMessage: ChatHistoryMessage;
    }
  | { ok: false; error: string };

// Single round-trip "user submits, AI replies":
//   1. Validate input + resolve active session (creating one if needed).
//   2. Load the bounded history window for the prompt.
//   3. Build the conditioning context (known/recent vocab + mistake history).
//   4. Call Anthropic.
//   5. Persist the user turn, assistant turn, and corrections in order.
//   6. Bump session counters so the next turn knows whether to summarise.
//
// We persist *after* the model call rather than before so a failed
// completion doesn't pollute the transcript with an orphan user turn that
// has no reply. The downside is a network hiccup loses the user's typed
// text; the UI keeps it locally until the action resolves to mitigate that.
export async function sendChatMessageAction(
  input: SendChatMessageInput,
): Promise<SendChatMessageResult> {
  const parsed = SendInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid request." };
  }

  const user = await requireUser();
  const supabase = await createServerSupabaseClient();
  if (!supabase) {
    return { ok: false, error: "Supabase is not configured for this environment." };
  }

  const level: ChatLevel = parsed.data.level ?? "beginner";
  let session;
  try {
    session = await getOrCreateActiveSession(supabase, user.id, level);
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }

  // If the caller provided a sessionId, verify it belongs to the user and
  // is still active. Otherwise fall back to the implicit active session.
  if (parsed.data.sessionId && parsed.data.sessionId !== session.id) {
    return { ok: false, error: "Chat session is no longer active." };
  }

  const trimmedMessage = parsed.data.message.trim();
  if (trimmedMessage.length === 0) {
    return { ok: false, error: "Message is empty." };
  }

  let priorMessages: ChatHistoryMessage[];
  try {
    priorMessages = await loadSessionMessages(supabase, session.id, user.id, CHAT_HISTORY_WINDOW);
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }

  let context;
  try {
    context = await buildConversationContext(supabase, user.id, session);
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }

  // VOL-138: record every Anthropic chat call into provider_usage_events so
  // chat spend rolls up alongside the lesson pipeline's costs. The recorder
  // is built from the service-role client because the table has no INSERT
  // policy for authenticated users (telemetry crosses households and must
  // not be reachable from a client session).
  const recordUsage = createProviderUsageRecorder(createServiceRoleClient());
  const inferenceStartedAt = Date.now();
  let inference;
  try {
    inference = await inferConversationWithAnthropic({
      context,
      history: toChatTurns(priorMessages),
      userMessage: trimmedMessage,
    });
  } catch (error) {
    await recordUsage({
      provider: ANTHROPIC_CONVERSATION_PROVIDER_ID,
      operation: "llm",
      surface: "chat",
      userId: user.id,
      status: "failed",
      latencyMs: Date.now() - inferenceStartedAt,
      error: messageOf(error),
      metadata: {
        session_id: session.id,
        level,
      },
    });
    return { ok: false, error: messageOf(error) };
  }
  await recordUsage({
    provider: ANTHROPIC_CONVERSATION_PROVIDER_ID,
    operation: "llm",
    surface: "chat",
    userId: user.id,
    model: inference.model,
    inputTokens: inference.usage.inputTokens,
    outputTokens: inference.usage.outputTokens,
    latencyMs: Date.now() - inferenceStartedAt,
    costMicroUsd: estimateCostMicroUsd({
      provider: "anthropic-conversation",
      model: inference.model,
      inputTokens: inference.usage.inputTokens,
      outputTokens: inference.usage.outputTokens,
    }),
    metadata: {
      session_id: session.id,
      prompt_version: inference.promptVersion,
      level,
    },
  });

  // Insert user message first so the assistant message + corrections can
  // reference its id, then insert the assistant turn, then the corrections
  // (which point at the *user* message they critique).
  const userMessageRow: TablesInsert<"chat_messages"> = {
    session_id: session.id,
    user_id: user.id,
    role: "user",
    content: trimmedMessage,
    language: "id",
    metadata: { client_submitted_at: new Date().toISOString() },
  };
  const { data: userInserted, error: userInsertError } = await supabase
    .from("chat_messages")
    .insert(userMessageRow)
    .select("*")
    .single();
  if (userInsertError || !userInserted) {
    return {
      ok: false,
      error: `Could not save user message: ${userInsertError?.message ?? "missing"}`,
    };
  }

  const assistantRow: TablesInsert<"chat_messages"> = {
    session_id: session.id,
    user_id: user.id,
    role: "assistant",
    content: inference.response.reply,
    language: inference.response.replyLanguage,
    metadata: {
      model: inference.model,
      prompt_version: inference.promptVersion,
      raw_response: inference.rawResponse,
    },
  };
  const { data: assistantInserted, error: assistantInsertError } = await supabase
    .from("chat_messages")
    .insert(assistantRow)
    .select("*")
    .single();
  if (assistantInsertError || !assistantInserted) {
    return {
      ok: false,
      error: `Could not save assistant message: ${assistantInsertError?.message ?? "missing"}`,
    };
  }

  const corrections = inference.response.corrections;
  if (corrections.length > 0) {
    const correctionRows: TablesInsert<"chat_corrections">[] = corrections.map((c) => ({
      message_id: userInserted.id,
      session_id: session.id,
      user_id: user.id,
      kind: c.kind,
      source_text: c.sourceText,
      corrected_text: c.correctedText,
      explanation: c.explanation ?? null,
    }));
    const { error: correctionInsertError } = await supabase
      .from("chat_corrections")
      .insert(correctionRows);
    if (correctionInsertError) {
      return {
        ok: false,
        error: `Could not save corrections: ${correctionInsertError.message}`,
      };
    }
  }

  // Bump counters + last_message_at atomically so a concurrent second tab
  // / double-submit cannot lose an increment via read-modify-write. The
  // RPC runs as the caller and gates on auth.uid() = user_id so RLS is
  // still enforced. The summary-trigger threshold (shouldSummarizeHistory)
  // reads these counters next round-trip, so a lost increment would
  // misfire it.
  const { error: updateError } = await supabase.rpc("bump_chat_session_counters", {
    p_session_id: session.id,
    p_message_increment: 2,
    p_user_message_increment: 1,
  });
  if (updateError) {
    return { ok: false, error: `Could not update session: ${updateError.message}` };
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
  };
}

const StartOverInputSchema = z.object({
  level: ChatLevelSchema.optional(),
});

export type StartChatOverInput = z.infer<typeof StartOverInputSchema>;

export type StartChatOverResult = { ok: true; sessionId: string } | { ok: false; error: string };

// Ends the current chat session and opens a fresh one. The previous row
// stays in chat_sessions for future analytics (e.g. how long sessions run
// before the user resets). Old messages remain readable via that session's
// id but no longer feed the active prompt context.
export async function startChatOverAction(
  input: StartChatOverInput = {},
): Promise<StartChatOverResult> {
  const parsed = StartOverInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Invalid request." };
  }
  const user = await requireUser();
  const supabase = await createServerSupabaseClient();
  if (!supabase) {
    return { ok: false, error: "Supabase is not configured for this environment." };
  }
  try {
    const session = await startNewSession(supabase, user.id, parsed.data.level ?? "beginner");
    return { ok: true, sessionId: session.id };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error.";
}

export type { ChatCorrection };
