import { describe, expect, it } from "vitest";
import {
  SCENARIO_COMPLETION_XP,
  SCENARIO_DEFINITIONS,
  SCENARIO_IDS,
  SCENARIO_MAX_USER_TURNS,
  ScenarioAssistantResponseSchema,
  ScenarioConversationContextSchema,
  ScenarioDefinitionSchema,
  ScenarioIdSchema,
  getScenarioDefinition,
} from "../src/schemas/scenario.js";

describe("SCENARIO_DEFINITIONS", () => {
  it("ships exactly the 8 PRD scenarios", () => {
    const expectedIds = [
      "ordering-food",
      "taxi",
      "hotel-check-in",
      "market-bargaining",
      "asking-directions",
      "pharmacy",
      "beach-rental",
      "ojek-grab",
    ];
    expect(SCENARIO_IDS).toHaveLength(8);
    expect([...SCENARIO_IDS]).toEqual(expectedIds);
    expect(SCENARIO_DEFINITIONS).toHaveLength(8);
    expect(SCENARIO_DEFINITIONS.map((s) => s.id).sort()).toEqual(expectedIds.slice().sort());
  });

  it("every definition is well-formed (validates against the schema)", () => {
    for (const scenario of SCENARIO_DEFINITIONS) {
      expect(() => ScenarioDefinitionSchema.parse(scenario)).not.toThrow();
    }
  });

  it("every definition carries at least one goal and one suggested vocab item", () => {
    for (const scenario of SCENARIO_DEFINITIONS) {
      expect(scenario.goals.length).toBeGreaterThan(0);
      expect(scenario.suggestedVocab.length).toBeGreaterThan(0);
    }
  });

  it("the counterpart opens each scene in Bahasa Indonesia (non-empty string)", () => {
    for (const scenario of SCENARIO_DEFINITIONS) {
      expect(scenario.counterpartOpening.length).toBeGreaterThan(0);
    }
  });
});

describe("getScenarioDefinition", () => {
  it("returns the matching definition for a known id", () => {
    const def = getScenarioDefinition("ordering-food");
    expect(def.title).toMatch(/warung/i);
  });

  it("throws for an unknown id (defensive — caller should validate first)", () => {
    expect(() => getScenarioDefinition("not-a-scenario" as never)).toThrow();
  });
});

describe("ScenarioIdSchema", () => {
  it("accepts the canonical ids", () => {
    for (const id of SCENARIO_IDS) {
      expect(ScenarioIdSchema.parse(id)).toBe(id);
    }
  });

  it("rejects unknown ids", () => {
    expect(() => ScenarioIdSchema.parse("something-else")).toThrow();
  });
});

describe("ScenarioConversationContextSchema", () => {
  it("requires scenarioId + level and defaults everything else", () => {
    const parsed = ScenarioConversationContextSchema.parse({
      scenarioId: "taxi",
      level: "beginner",
    });
    expect(parsed.knownVocab).toEqual([]);
    expect(parsed.recentLessonVocab).toEqual([]);
    expect(parsed.recentCorrections).toEqual([]);
    expect(parsed.userTurnCount).toBe(0);
  });

  it("rejects an unknown scenario id", () => {
    expect(() =>
      ScenarioConversationContextSchema.parse({ scenarioId: "nope", level: "beginner" }),
    ).toThrow();
  });
});

describe("ScenarioAssistantResponseSchema", () => {
  it("defaults sceneComplete and corrections when omitted", () => {
    const parsed = ScenarioAssistantResponseSchema.parse({ reply: "Halo!" });
    expect(parsed.sceneComplete).toBe(false);
    expect(parsed.corrections).toEqual([]);
    expect(parsed.replyLanguage).toBe("id");
  });

  it("rejects an empty reply (the runner relies on the field)", () => {
    expect(() => ScenarioAssistantResponseSchema.parse({ reply: "" })).toThrow();
  });

  it("preserves sceneComplete = true when supplied", () => {
    const parsed = ScenarioAssistantResponseSchema.parse({
      reply: "Sampai jumpa!",
      sceneComplete: true,
    });
    expect(parsed.sceneComplete).toBe(true);
  });
});

describe("constants", () => {
  it("pins the XP award and turn cap to known small values", () => {
    expect(SCENARIO_COMPLETION_XP).toBe(10);
    expect(SCENARIO_MAX_USER_TURNS).toBeGreaterThan(0);
    expect(SCENARIO_MAX_USER_TURNS).toBeLessThan(40);
  });
});
