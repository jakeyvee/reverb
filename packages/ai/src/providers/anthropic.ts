import Anthropic from "@anthropic-ai/sdk";
import { aiEnv } from "../env.js";

let cached: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!cached) cached = new Anthropic({ apiKey: aiEnv.anthropicApiKey() });
  return cached;
}

// Captured from the Anthropic response.usage envelope so downstream code can
// log token counts onto provider_usage_events without re-reading the raw
// payload. Cache + ephemeral tokens are tracked separately in the SDK; for
// the cost-guardrail use case we only need the bill-driving fields.
export interface AnthropicUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AnthropicCompletionInput {
  model: string;
  system?: string;
  user: string;
  maxTokens?: number;
}

export interface AnthropicCompletionResult {
  text: string;
  usage: AnthropicUsage;
}

export async function anthropicCompletion(
  input: AnthropicCompletionInput,
): Promise<AnthropicCompletionResult> {
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: input.model,
    system: input.system,
    max_tokens: input.maxTokens ?? 1024,
    messages: [{ role: "user", content: input.user }],
  });
  const first = response.content[0];
  return {
    text: first && first.type === "text" ? first.text : "",
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}

export interface AnthropicChatTurnInput {
  role: "user" | "assistant";
  content: string;
}

export interface AnthropicChatCompletionInput {
  model: string;
  system?: string;
  messages: AnthropicChatTurnInput[];
  maxTokens?: number;
}

// Multi-turn variant of `anthropicCompletion`. Used by the chat partner so
// the model receives the bounded conversation tail (system prompt + last N
// user/assistant turns) rather than a single flat user blob. Returns the
// first text block of the response, matching the single-turn helper's
// contract so callers can share parsing code.
export async function anthropicChatCompletion(
  input: AnthropicChatCompletionInput,
): Promise<AnthropicCompletionResult> {
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: input.model,
    system: input.system,
    max_tokens: input.maxTokens ?? 1024,
    messages: input.messages.map((turn) => ({ role: turn.role, content: turn.content })),
  });
  const first = response.content[0];
  return {
    text: first && first.type === "text" ? first.text : "",
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}
