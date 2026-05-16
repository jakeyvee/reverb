import type { ScenarioAssistantResponse, ScenarioConversationContext } from "@reverb/domain";
import { anthropicChatCompletion } from "./anthropic.js";
import {
  SCENARIO_DEFAULT_MODEL,
  SCENARIO_MAX_TOKENS,
  SCENARIO_PROMPT_VERSION,
  buildScenarioMessages,
  buildScenarioSystemPrompt,
  parseScenarioResponse,
} from "../prompts/scenario.js";

export const ANTHROPIC_SCENARIO_PROVIDER_ID = "anthropic-scenario";

export type InferScenarioInput = {
  context: ScenarioConversationContext;
  // Bounded conversation tail. The caller is responsible for windowing.
  // Splitting `history` from `userMessage` keeps it explicit which turn is
  // being graded for corrections.
  history: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
  userMessage: string;
  /**
   * Seed the persona's opening line as the first assistant turn when the
   * history is empty. Defaults to true so the model has scene context on
   * the very first user message.
   */
  seedOpening?: boolean;
  /** Override the default Anthropic model for tests / experiments. */
  model?: string;
  /** Override the default response token cap. */
  maxTokens?: number;
};

export type InferScenarioResult = {
  /** Domain-validated structured reply. */
  response: ScenarioAssistantResponse;
  /** Untrimmed model response, useful for *_messages.metadata. */
  rawResponse: string;
  /** Model id actually used. */
  model: string;
  /** Prompt version stamped on the turn; persisted for replay. */
  promptVersion: string;
};

export async function inferScenarioWithAnthropic(
  input: InferScenarioInput,
): Promise<InferScenarioResult> {
  const model = input.model ?? SCENARIO_DEFAULT_MODEL;
  const system = buildScenarioSystemPrompt(input.context);
  const messages = buildScenarioMessages({
    scenarioId: input.context.scenarioId,
    history: input.history,
    nextUserMessage: input.userMessage,
    seedOpening: input.seedOpening,
  });

  const rawResponse = await anthropicChatCompletion({
    model,
    system,
    messages,
    maxTokens: input.maxTokens ?? SCENARIO_MAX_TOKENS,
  });

  const response = parseScenarioResponse(rawResponse);
  return {
    response,
    rawResponse,
    model,
    promptVersion: SCENARIO_PROMPT_VERSION,
  };
}
