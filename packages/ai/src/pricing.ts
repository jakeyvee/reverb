// Per-provider unit prices used to estimate run cost at log time (VOL-138).
//
// Cost is *frozen at insert time* on provider_usage_events.cost_micro_usd —
// updating the rates here does not retroactively rewrite history. The
// estimates anchor on the public list price for each provider so the monthly
// cost view is comparable to the $30/month operating cap from the project
// brief. Real billing happens upstream; this is a guardrail, not invoicing.
//
// Units are USD micro-dollars (1/1,000,000 of a dollar) so a single
// Anthropic input token (~3 micro-USD on Sonnet 4.5) does not round to zero
// when persisted. BIGINT in the DB matches.

const USD_MICRO = 1_000_000;

// USD per 1,000,000 tokens / characters / minute, copied from the providers'
// public pricing pages on 2026-05-16. Update with a comment when prices
// change so cost_usd_sum in provider_usage_monthly stays interpretable.
export const PROVIDER_RATES = {
  // https://console.groq.com/pricing — Whisper Large v3 priced at $0.111 per
  // hour of audio.
  groq: {
    "whisper-large-v3": {
      audioHourUsd: 0.111,
    },
  },
  // https://www.anthropic.com/pricing — Claude Sonnet 4.5 input/output rates.
  // Haiku is cheaper; default to Sonnet because the diarization, extraction,
  // and conversation prompts all target Sonnet today.
  anthropic: {
    "claude-sonnet-4-5": {
      inputMTokUsd: 3,
      outputMTokUsd: 15,
    },
    "claude-sonnet-4-5-20250929": {
      inputMTokUsd: 3,
      outputMTokUsd: 15,
    },
    "claude-haiku-4-5": {
      inputMTokUsd: 0.8,
      outputMTokUsd: 4,
    },
    "claude-haiku-4-5-20251001": {
      inputMTokUsd: 0.8,
      outputMTokUsd: 4,
    },
  },
  // https://cloud.google.com/text-to-speech/pricing — WaveNet voices at
  // $16/M chars; Standard voices at $4/M chars. We default to Wavenet for
  // vocab audio.
  google: {
    wavenet: { perMCharsUsd: 16 },
    standard: { perMCharsUsd: 4 },
  },
} as const;

export type AsrCostInput = {
  provider: "groq-whisper";
  model: string;
  audioDurationMs: number;
};

export type LlmCostInput = {
  provider: "anthropic-diarization" | "anthropic-extraction" | "anthropic-conversation";
  model: string;
  inputTokens: number;
  outputTokens: number;
};

export type TtsCostInput = {
  provider: "google-tts";
  // Voice name as fed to the synthesize request (e.g. "id-ID-Wavenet-A"); the
  // tier is derived from the substring match.
  voiceName?: string | null;
  characterCount: number;
};

export type ProviderCostInput = AsrCostInput | LlmCostInput | TtsCostInput;

// Returns the estimated cost of a single provider call in micro-USD, or null
// when the model is unrecognised. Callers persist the value as-is; null
// rows still record usage metadata but skip the cost-sum column.
export function estimateCostMicroUsd(input: ProviderCostInput): number | null {
  switch (input.provider) {
    case "groq-whisper": {
      const rate = PROVIDER_RATES.groq[input.model as keyof typeof PROVIDER_RATES.groq];
      if (!rate) return null;
      const hours = input.audioDurationMs / 1000 / 3600;
      return Math.round(hours * rate.audioHourUsd * USD_MICRO);
    }
    case "anthropic-diarization":
    case "anthropic-extraction":
    case "anthropic-conversation": {
      const rate = lookupAnthropicRate(input.model);
      if (!rate) return null;
      const inputUsd = (input.inputTokens / 1_000_000) * rate.inputMTokUsd;
      const outputUsd = (input.outputTokens / 1_000_000) * rate.outputMTokUsd;
      return Math.round((inputUsd + outputUsd) * USD_MICRO);
    }
    case "google-tts": {
      const tier = pickGoogleTtsTier(input.voiceName);
      const rate = PROVIDER_RATES.google[tier];
      const usd = (input.characterCount / 1_000_000) * rate.perMCharsUsd;
      return Math.round(usd * USD_MICRO);
    }
  }
}

// Anthropic dated model ids look like "claude-sonnet-4-5-20250929". Strip the
// trailing date if a literal lookup misses so we don't blow up the rate map
// on every minor revision.
function lookupAnthropicRate(model: string): { inputMTokUsd: number; outputMTokUsd: number } | null {
  const direct = PROVIDER_RATES.anthropic[model as keyof typeof PROVIDER_RATES.anthropic];
  if (direct) return direct;
  const dateless = model.replace(/-\d{8}$/, "");
  return (
    (PROVIDER_RATES.anthropic[dateless as keyof typeof PROVIDER_RATES.anthropic] as
      | { inputMTokUsd: number; outputMTokUsd: number }
      | undefined) ?? null
  );
}

function pickGoogleTtsTier(voiceName: string | null | undefined): "wavenet" | "standard" {
  if (!voiceName) return "wavenet";
  const lower = voiceName.toLowerCase();
  if (lower.includes("wavenet") || lower.includes("neural")) return "wavenet";
  if (lower.includes("standard")) return "standard";
  // Unknown voice — assume the higher rate so the guardrail errs toward
  // over-counting cost rather than under.
  return "wavenet";
}
