import { describe, expect, it } from "vitest";
import {
  SCENARIO_MAX_USER_TURNS,
  type ScenarioConversationContext,
  getScenarioDefinition,
} from "@reverb/domain";
import {
  SCENARIO_DEFAULT_MODEL,
  SCENARIO_PROMPT_VERSION,
  buildScenarioMessages,
  buildScenarioSystemPrompt,
  parseScenarioResponse,
} from "../src/prompts/scenario.js";

const baseContext: ScenarioConversationContext = {
  scenarioId: "market-bargaining",
  level: "beginner",
  knownVocab: [
    { lemma: "berapa", translation: "how much" },
    { lemma: "mahal", translation: "expensive" },
  ],
  recentLessonVocab: [{ lemma: "tawar", translation: "to bargain" }],
  recentCorrections: [
    { sourceText: "Saya mau dua", correctedText: "Saya mau beli dua", kind: "grammar" },
  ],
  userTurnCount: 0,
};

describe("buildScenarioSystemPrompt", () => {
  it("includes the scene, learner role, and counterpart role from the definition", () => {
    const prompt = buildScenarioSystemPrompt(baseContext);
    const def = getScenarioDefinition("market-bargaining");
    expect(prompt).toContain(def.setting);
    expect(prompt).toContain(def.userRole);
    expect(prompt).toContain(def.counterpartRole);
  });

  it("locks the partner into Bahasa Indonesia and forbids breaking character", () => {
    const prompt = buildScenarioSystemPrompt(baseContext);
    expect(prompt).toMatch(/Reply in Bahasa Indonesia/);
    expect(prompt).toMatch(/Stay in character/);
  });

  it("encodes level-specific guidance", () => {
    const beginner = buildScenarioSystemPrompt(baseContext);
    expect(beginner).toMatch(/beginner/i);
    const advanced = buildScenarioSystemPrompt({ ...baseContext, level: "advanced" });
    expect(advanced).toMatch(/advanced/i);
  });

  it("inlines scenario-specific suggested vocab and learner vocab", () => {
    const prompt = buildScenarioSystemPrompt(baseContext);
    expect(prompt).toMatch(/Scene-specific vocabulary/);
    expect(prompt).toMatch(/tawar/);
    expect(prompt).toMatch(/already mastered/);
    expect(prompt).toMatch(/berapa \(how much\)/);
  });

  it("calls out recent corrections as patterns to re-check", () => {
    const prompt = buildScenarioSystemPrompt(baseContext);
    expect(prompt).toMatch(/Recent mistakes/);
    expect(prompt).toMatch(/Saya mau dua/);
  });

  it("includes the goals checklist and wrap-up cue", () => {
    const prompt = buildScenarioSystemPrompt(baseContext);
    const def = getScenarioDefinition("market-bargaining");
    for (const goal of def.goals) {
      expect(prompt).toContain(goal);
    }
    expect(prompt).toContain(def.completionHint);
  });

  it("nudges the model to close once the user is close to the turn cap", () => {
    const tight = buildScenarioSystemPrompt({
      ...baseContext,
      userTurnCount: SCENARIO_MAX_USER_TURNS - 2,
    });
    expect(tight).toMatch(/learner turns? remain/);

    const fresh = buildScenarioSystemPrompt(baseContext);
    expect(fresh).not.toMatch(/learner turns? remain/);
  });

  it("declares the strict JSON contract including sceneComplete", () => {
    const prompt = buildScenarioSystemPrompt(baseContext);
    expect(prompt).toMatch(/Output STRICT JSON/);
    expect(prompt).toMatch(/"reply":/);
    expect(prompt).toMatch(/"sceneComplete":/);
  });
});

describe("buildScenarioMessages", () => {
  it("seeds the persona's opening line on a fresh history and appends the user message", () => {
    const def = getScenarioDefinition("taxi");
    const out = buildScenarioMessages({
      scenarioId: "taxi",
      history: [],
      nextUserMessage: "Tolong antar ke bandara.",
    });
    expect(out).toEqual([
      { role: "assistant", content: def.counterpartOpening },
      { role: "user", content: "Tolong antar ke bandara." },
    ]);
  });

  it("does not double-seed when history is non-empty", () => {
    const out = buildScenarioMessages({
      scenarioId: "taxi",
      history: [
        { role: "assistant", content: "Tujuan ke mana?" },
        { role: "user", content: "Ke bandara." },
      ],
      nextUserMessage: "Lewat tol saja.",
    });
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ role: "assistant", content: "Tujuan ke mana?" });
    expect(out[out.length - 1]).toEqual({ role: "user", content: "Lewat tol saja." });
  });

  it("respects seedOpening = false even for empty history", () => {
    const out = buildScenarioMessages({
      scenarioId: "taxi",
      history: [],
      nextUserMessage: "Halo, Pak.",
      seedOpening: false,
    });
    expect(out).toEqual([{ role: "user", content: "Halo, Pak." }]);
  });
});

describe("parseScenarioResponse", () => {
  it("parses a well-formed payload with sceneComplete", () => {
    const parsed = parseScenarioResponse(
      JSON.stringify({
        reply: "Baik, harganya pas ya. Terima kasih!",
        replyLanguage: "id",
        corrections: [],
        sceneComplete: true,
      }),
    );
    expect(parsed.sceneComplete).toBe(true);
    expect(parsed.corrections).toEqual([]);
  });

  it("recovers a JSON object wrapped in stray prose", () => {
    const wrapped = `Sure:\n\`\`\`json\n{"reply":"Halo!","sceneComplete":false}\n\`\`\``;
    const parsed = parseScenarioResponse(wrapped);
    expect(parsed.reply).toBe("Halo!");
  });

  it("throws on invalid JSON", () => {
    expect(() => parseScenarioResponse("not json")).toThrow();
  });
});

describe("pinned constants", () => {
  it("pins the prompt version so a future change can be migrated forward", () => {
    expect(SCENARIO_PROMPT_VERSION).toMatch(/^scenario-/);
  });

  it("pins the default model so silent upstream changes surface in code", () => {
    expect(SCENARIO_DEFAULT_MODEL).toMatch(/claude/);
  });
});
