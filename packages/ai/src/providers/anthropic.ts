import Anthropic from "@anthropic-ai/sdk";
import { aiEnv } from "../env.js";

let cached: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (!cached) cached = new Anthropic({ apiKey: aiEnv.anthropicApiKey() });
  return cached;
}

export interface AnthropicCompletionInput {
  model: string;
  system?: string;
  user: string;
  maxTokens?: number;
}

export async function anthropicCompletion(input: AnthropicCompletionInput): Promise<string> {
  const client = getAnthropicClient();
  const response = await client.messages.create({
    model: input.model,
    system: input.system,
    max_tokens: input.maxTokens ?? 1024,
    messages: [{ role: "user", content: input.user }],
  });
  const first = response.content[0];
  return first && first.type === "text" ? first.text : "";
}
