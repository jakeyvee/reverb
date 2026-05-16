import {
  SCENARIO_MAX_USER_TURNS,
  ScenarioAssistantResponseSchema,
  getScenarioDefinition,
  type ScenarioAssistantResponse,
  type ScenarioConversationContext,
  type ScenarioLevel,
  type ScenarioVocabContextItem,
} from "@reverb/domain";

// VOL-133: Travel role-play scenarios.
//
// The scenario prompt is a sibling of the free-form chat prompt — both
// produce a structured assistant payload with a reply + corrections — but
// the scenario flavour pins a persona and a goal so practice stays in a
// constrained "useful short practice" window.
//
// The prompt is built from three layers:
//   1. The static `ScenarioDefinition` (setting, persona, opening line,
//      goals, suggested vocab) — comes from the canonical list in domain.
//   2. The user's vocab + recent corrections — same loaders the chat prompt
//      uses, so the model leans on language the user already recognises.
//   3. A turn-budget signal (`userTurnCount` vs. SCENARIO_MAX_USER_TURNS)
//      so the model nudges the scene toward an ending instead of looping.

export const SCENARIO_PROMPT_VERSION = "scenario-v1";

// Same Haiku tier as the chat partner. Scenarios are interactive — UI is
// blocked waiting on the reply — so we trade peak quality for latency and
// cost. JSON-mode reliability on Haiku has been strong enough for the chat
// flow (same structured payload shape) so reusing it here is low risk.
export const SCENARIO_DEFAULT_MODEL = "claude-haiku-4-5-20251001";

// Slightly higher than the free-form chat budget because scenario replies
// often need a bit more setup ("Tujuannya ke mana? Berapa lama mau pergi?")
// plus the sceneComplete signal.
export const SCENARIO_MAX_TOKENS = 1024;

const LEVEL_GUIDANCE: Record<ScenarioLevel, string> = {
  beginner: [
    "The learner is a beginner. Keep your replies in short, simple sentences (one or two clauses each).",
    "Stick to high-frequency Bahasa Indonesia: present tense, simple affixes, no slang.",
    "If the learner is clearly stuck, you may offer a brief English gloss in parentheses after a phrase — but stay in Indonesian otherwise.",
  ].join(" "),
  intermediate: [
    "The learner is intermediate. Use natural Bahasa Indonesia with common affixes (meN-, di-, ber-, ter-).",
    "Two-clause replies are fine. Introduce light idiomatic phrasing when it fits the scene.",
  ].join(" "),
  advanced: [
    "The learner is advanced. Use natural, native-register Bahasa Indonesia including casual/idiom and code-mixing where appropriate to the scene.",
    "Match formality to your persona — a market seller is informal, a hotel receptionist is formal.",
  ].join(" "),
};

export function buildScenarioSystemPrompt(context: ScenarioConversationContext): string {
  const definition = getScenarioDefinition(context.scenarioId);
  const lines: string[] = [];

  lines.push(
    "You are Reverb's role-play partner for a fixed Bahasa Indonesia travel scenario.",
    `Scene: ${definition.setting}`,
    `Learner's role: ${definition.userRole}`,
    `Your role: ${definition.counterpartRole}`,
    "",
    "How you behave:",
    "- Stay in character. Never break the fourth wall by referring to 'the scenario', 'the exercise', or 'the AI'.",
    "- Reply in Bahasa Indonesia. English may only appear briefly inside corrections[].explanation, or as a parenthetical gloss for one tricky word if the learner is clearly stuck.",
    "- Keep replies short (1–3 sentences). Ask a single follow-up question so the learner has something concrete to respond to.",
    "- Do not narrate stage directions. Speak as the persona would speak.",
    "- One correction per distinct mistake the learner makes. Don't restate the same mistake in multiple categories. If the learner's Indonesian is fine, return an empty `corrections` array — don't invent mistakes.",
    "",
    "Goals the learner needs to accomplish in this scene:",
    ...definition.goals.map((g) => `  - ${g}`),
    "",
    `Wrap-up cue: ${definition.completionHint}`,
    `Mark "sceneComplete": true when the wrap-up cue has been met, or when the learner explicitly says goodbye / leaves. Otherwise keep it false. Once you mark sceneComplete true, your reply should be a short, in-character closing line.`,
    "",
    `Level guidance: ${LEVEL_GUIDANCE[context.level]}`,
  );

  const suggested = definition.suggestedVocab.join(", ");
  if (suggested.length > 0) {
    lines.push("", "Scene-specific vocabulary to lean on (prefer these when natural):", suggested);
  }

  const known = formatVocabList(context.knownVocab);
  if (known) {
    lines.push(
      "",
      "Vocabulary the learner has already mastered from their lessons. Prefer these when they fit the scene — they will recognise them quickly.",
      known,
    );
  }

  const recent = formatVocabList(context.recentLessonVocab);
  if (recent) {
    lines.push(
      "",
      "Vocabulary from the learner's recent lessons. Weave these in when the topic allows — this is the freshest material they've been studying.",
      recent,
    );
  }

  if (context.recentCorrections.length > 0) {
    lines.push(
      "",
      "Recent mistakes this learner has been corrected on. If they repeat one of these patterns, you MUST surface a correction; otherwise let it pass.",
    );
    for (const c of context.recentCorrections) {
      lines.push(`- ✗ "${c.sourceText}" → ✓ "${c.correctedText}"`);
    }
  }

  // Turn budget hint. The hard cap is enforced server-side; the model sees a
  // soft signal so it knows when to start closing the scene gracefully.
  const turnsRemaining = Math.max(0, SCENARIO_MAX_USER_TURNS - context.userTurnCount);
  if (turnsRemaining <= 4) {
    lines.push(
      "",
      `Only about ${turnsRemaining} learner turn${turnsRemaining === 1 ? "" : "s"} remain. Start steering the scene toward a natural close — pay the bill, get the room key, agree on a price, etc.`,
    );
  }

  lines.push(
    "",
    "Output STRICT JSON, no prose, no markdown fences. Exact shape:",
    "{",
    '  "reply": "<your Indonesian reply, 1–3 sentences>",',
    '  "replyLanguage": "id",',
    '  "corrections": [',
    "    {",
    '      "kind": "grammar|vocabulary|pronunciation|usage",',
    '      "sourceText": "<the exact wrong phrase from the learner\'s message>",',
    '      "correctedText": "<the corrected Indonesian phrase>",',
    '      "explanation": "<short English explanation, optional, <= 1 sentence>"',
    "    }",
    "  ],",
    '  "sceneComplete": <true if the wrap-up cue has been met, else false>',
    "}",
    "If the learner wrote correctly, `corrections` is `[]`. Always emit valid JSON.",
  );

  return lines.join("\n");
}

function formatVocabList(items: ScenarioVocabContextItem[]): string | null {
  if (items.length === 0) return null;
  return items
    .map((item) =>
      item.translation && item.translation.trim().length > 0
        ? `- ${item.lemma} (${item.translation})`
        : `- ${item.lemma}`,
    )
    .join("\n");
}

// Anthropic message turns we forward verbatim. The scenario prompt seeds
// the conversation with the counterpart's opening line as the first
// assistant turn so the model knows the scene has already started — that
// also matches what the UI renders before the learner has typed anything.
export type AnthropicScenarioTurn = {
  role: "user" | "assistant";
  content: string;
};

export function buildScenarioMessages(args: {
  scenarioId: ScenarioConversationContext["scenarioId"];
  history: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
  nextUserMessage: string;
  /**
   * When the history is empty we prepend the persona's opening line as the
   * first assistant turn so the model has something to play off. If the
   * caller already seeded that turn into `history` themselves, set this to
   * false to avoid double-seeding.
   */
  seedOpening?: boolean;
}): AnthropicScenarioTurn[] {
  const out: AnthropicScenarioTurn[] = [];
  const seed = args.seedOpening ?? true;
  if (seed && args.history.length === 0) {
    const definition = getScenarioDefinition(args.scenarioId);
    out.push({ role: "assistant", content: definition.counterpartOpening });
  }
  for (const turn of args.history) {
    out.push({ role: turn.role, content: turn.content });
  }
  out.push({ role: "user", content: args.nextUserMessage });
  return out;
}

function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Scenario response did not contain a JSON object");
  }
  return trimmed.slice(start, end + 1);
}

export function parseScenarioResponse(raw: string): ScenarioAssistantResponse {
  const json = extractJsonObject(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `Scenario response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return ScenarioAssistantResponseSchema.parse(parsed);
}
