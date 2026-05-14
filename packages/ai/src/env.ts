function required(name: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const aiEnv = {
  groqApiKey: () => required("GROQ_API_KEY", process.env.GROQ_API_KEY),
  anthropicApiKey: () => required("ANTHROPIC_API_KEY", process.env.ANTHROPIC_API_KEY),
  googleTtsKey: () => process.env.GOOGLE_TTS_API_KEY ?? null,
  googleAppCredentials: () => process.env.GOOGLE_APPLICATION_CREDENTIALS ?? null,
};
