import type { ChatAssistantResponse, ChatConversationContext, ChatTurn } from "@reverb/domain";
import { anthropicChatCompletion, type AnthropicUsage } from "./anthropic.js";
import {
  CONVERSATION_DEFAULT_MODEL,
  CONVERSATION_MAX_TOKENS,
  CONVERSATION_PROMPT_VERSION,
  buildConversationMessages,
  buildConversationSystemPrompt,
  parseConversationResponse,
} from "../prompts/conversation.js";

export const ANTHROPIC_CONVERSATION_PROVIDER_ID = "anthropic-conversation";

export type InferConversationInput = {
  context: ChatConversationContext;
  // The conversation tail (already windowed by the caller) plus the new
  // user turn the model is replying to. Splitting `history` from `userMessage`
  // makes it explicit which turn is being graded for corrections.
  history: ChatTurn[];
  userMessage: string;
  /** Override the default Anthropic model for tests / experiments. */
  model?: string;
  /** Override the default response token cap. */
  maxTokens?: number;
};

export type InferConversationResult = {
  /** Domain-validated structured reply (reply + corrections array). */
  response: ChatAssistantResponse;
  /** Untrimmed model response, useful for chat_messages.metadata. */
  rawResponse: string;
  /** Model id actually used. */
  model: string;
  /** Prompt version stamped on the turn; persisted for replay. */
  promptVersion: string;
  /** Token counts reported by Anthropic, persisted on provider_usage_events. */
  usage: AnthropicUsage;
};

export async function inferConversationWithAnthropic(
  input: InferConversationInput,
): Promise<InferConversationResult> {
  const model = input.model ?? CONVERSATION_DEFAULT_MODEL;
  const system = buildConversationSystemPrompt(input.context);
  const messages = buildConversationMessages(input.history, input.userMessage);

  const { text: rawResponse, usage } = await anthropicChatCompletion({
    model,
    system,
    messages,
    maxTokens: input.maxTokens ?? CONVERSATION_MAX_TOKENS,
  });

  const response = parseConversationResponse(rawResponse);
  return {
    response,
    rawResponse,
    model,
    promptVersion: CONVERSATION_PROMPT_VERSION,
    usage,
  };
}
