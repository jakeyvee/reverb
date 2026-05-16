import {
  ChatAssistantResponseSchema,
  type ChatAssistantResponse,
  type ChatConversationContext,
  type ChatLevel,
  type ChatTurn,
  type ChatVocabContextItem,
} from "@reverb/domain";

// Pinned with the chat partner the same way we pin extraction/diarization. A
// future change to the system prompt will bump this version, and a future
// migration may filter prior runs by it.
export const CONVERSATION_PROMPT_VERSION = "chat-v1";

// Default Anthropic model. Chat is latency-sensitive (a user is waiting in
// the UI) so we lean on Haiku — its JSON-mode reliability is strong enough
// for our small structured payload and the cost per turn stays low even
// across long sessions.
export const CONVERSATION_DEFAULT_MODEL = "claude-haiku-4-5-20251001";

// Hard ceiling on response tokens. The structured payload is tiny — a
// sentence or two of reply plus at most a couple of corrections — so a high
// limit just wastes time. Override per-call via `maxTokens` if a longer
// scenario ever needs it.
export const CONVERSATION_MAX_TOKENS = 768;

// Lesson-level expectations the system prompt reads to size grammar / vocab.
// Keep the bands compact so prompt diffs read at a glance.
const LEVEL_GUIDANCE: Record<ChatLevel, string> = {
  beginner: [
    "The student is a beginner. Stick to short, simple sentences (5–10 words).",
    "Prefer high-frequency Bahasa Indonesia: kamu/saya, present-tense, no slang.",
    "Avoid affixation chains (e.g. memper-...-kan) unless the student used them first.",
  ].join(" "),
  intermediate: [
    "The student is intermediate. Use natural Bahasa Indonesia with common affixes (meN-, di-, ber-, ter-).",
    "Sentences may be 1–2 clauses; introduce light idiomatic phrasing when it fits.",
  ].join(" "),
  advanced: [
    "The student is advanced. Use natural, native-register Bahasa Indonesia including idiom and slang where appropriate.",
    "Casual register is fine; switch to formal only if the student does first.",
  ].join(" "),
};

// Build the Indonesian conversation system prompt. Encodes:
//   1. Role / language guardrails (stay in Indonesian, English only as
//      brief fallback for explanation text or proper nouns).
//   2. Level expectation (sentence length, register, grammar band).
//   3. Vocab to lean on (known + recent lesson).
//   4. Mistake history to actively re-check.
//   5. Structured JSON output contract so the web layer can split reply
//      from corrections without parsing prose.
//   6. Optional rolling summary line so we don't have to re-feed older
//      turns when the conversation has grown past CHAT_SUMMARIZE_AFTER…
export function buildConversationSystemPrompt(context: ChatConversationContext): string {
  const lines: string[] = [];
  lines.push(
    "You are Reverb's AI Bahasa Indonesia conversation partner.",
    "You chat with a learner in Bahasa Indonesia. Your job is twofold:",
    "  (a) keep the conversation going naturally, asking short follow-up questions,",
    "  (b) silently spot mistakes in the learner's Indonesian and surface them as structured corrections.",
    "",
    "Hard rules — violations break the UI:",
    '- Reply in Bahasa Indonesia by default. Use English ONLY for short explanations inside `corrections[].explanation`, or when the learner explicitly asks in English and clearly can\'t continue in Indonesian. In that case keep the reply itself in Indonesian but add a short English bracketed gloss after, e.g. "Apa kabar? (How are you?)".',
    "- Never lecture in English in the main reply. The reply is conversation, not a lesson.",
    "- One correction per distinct mistake. Don't restate the same mistake in different categories.",
    "- If the learner's Indonesian is fine, return an empty `corrections` array. Don't invent mistakes.",
    "- Keep replies short (1–3 sentences). Always end the reply with a follow-up question to keep the chat moving.",
    "",
    `Level guidance: ${LEVEL_GUIDANCE[context.level]}`,
  );

  const known = formatVocabList(context.knownVocab);
  if (known) {
    lines.push(
      "",
      "Vocabulary the learner has already mastered. Prefer these words when natural — they will recognise them quickly.",
      known,
    );
  }
  const recent = formatVocabList(context.recentLessonVocab);
  if (recent) {
    lines.push(
      "",
      "Vocabulary from the learner's recent lessons. Weave these into your reply when the topic allows — this is the freshest material they have been studying.",
      recent,
    );
  }
  if (context.recentCorrections.length > 0) {
    lines.push(
      "",
      "Recent mistakes the learner has been corrected on. If the learner repeats one of these patterns, you MUST surface a correction; otherwise let it pass.",
    );
    for (const c of context.recentCorrections) {
      lines.push(`- ✗ "${c.sourceText}" → ✓ "${c.correctedText}"`);
    }
  }
  if (context.rollingSummary && context.rollingSummary.trim().length > 0) {
    lines.push(
      "",
      "Earlier in this conversation (rolling summary, English):",
      context.rollingSummary.trim(),
    );
  }

  lines.push(
    "",
    "Output STRICT JSON, no prose, no markdown fences. Exact shape:",
    "{",
    '  "reply": "<your Indonesian reply, 1–3 sentences ending in a question>",',
    '  "replyLanguage": "id",',
    '  "corrections": [',
    "    {",
    '      "kind": "grammar|vocabulary|pronunciation|usage",',
    '      "sourceText": "<the exact wrong phrase from the learner\'s message>",',
    '      "correctedText": "<the corrected Indonesian phrase>",',
    '      "explanation": "<short English explanation, optional, <= 1 sentence>"',
    "    }",
    "  ]",
    "}",
    "If the learner wrote correctly, `corrections` is `[]`. Always emit valid JSON.",
  );

  return lines.join("\n");
}

function formatVocabList(items: ChatVocabContextItem[]): string | null {
  if (items.length === 0) return null;
  return items
    .map((item) =>
      item.translation && item.translation.trim().length > 0
        ? `- ${item.lemma} (${item.translation})`
        : `- ${item.lemma}`,
    )
    .join("\n");
}

// Anthropic-style message turns we forward verbatim. The system prompt
// already encodes context and JSON contract, so the multi-turn payload is
// just the bounded conversation tail.
export type AnthropicChatTurn = {
  role: "user" | "assistant";
  content: string;
};

export function buildConversationMessages(
  history: ChatTurn[],
  nextUserMessage: string,
): AnthropicChatTurn[] {
  const out: AnthropicChatTurn[] = [];
  for (const turn of history) {
    out.push({ role: turn.role, content: turn.content });
  }
  out.push({ role: "user", content: nextUserMessage });
  return out;
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Conversation response did not contain a JSON object");
  }
  return trimmed.slice(start, end + 1);
}

// Parse + validate the assistant response. On malformed JSON we throw — the
// web action returns the error to the client, which can surface a "the AI
// glitched, try again" hint without persisting a half-formed turn.
export function parseConversationResponse(raw: string): ChatAssistantResponse {
  const json = extractJsonObject(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `Conversation response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return ChatAssistantResponseSchema.parse(parsed);
}
