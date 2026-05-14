import Groq from "groq-sdk";
import { aiEnv } from "../env.js";

let cached: Groq | null = null;

export function getGroqClient(): Groq {
  if (!cached) cached = new Groq({ apiKey: aiEnv.groqApiKey() });
  return cached;
}

export interface GroqCompletionInput {
  model: string;
  system?: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
}

export async function groqCompletion(input: GroqCompletionInput): Promise<string> {
  const client = getGroqClient();
  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  if (input.system) messages.push({ role: "system", content: input.system });
  messages.push({ role: "user", content: input.user });
  const response = await client.chat.completions.create({
    model: input.model,
    messages,
    temperature: input.temperature,
    max_tokens: input.maxTokens,
  });
  return response.choices[0]?.message?.content ?? "";
}
