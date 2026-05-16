// Provider usage recorder (VOL-138).
//
// Single seam every caller funnels through to log paid-provider calls into
// public.provider_usage_events. The recorder is intentionally forgiving: a
// failure to insert telemetry must not break the user-facing request, since
// the table only exists to estimate spend and surface silent errors. Insert
// errors are logged to stderr and swallowed.
//
// Callers pass an already-created service-role client. provider_usage_events
// has no INSERT policy for authenticated users — the service role bypasses
// RLS, which is the only way the row lands.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, TablesInsert } from "./types.js";

export type ProviderUsageStatus = "succeeded" | "failed";

export type RecordProviderUsageInput = {
  provider: string;
  operation: "asr" | "llm" | "tts";
  /** Free-form label describing where the call originated. */
  surface: string;
  model?: string | null;
  householdId?: string | null;
  userId?: string | null;
  lessonId?: string | null;
  status?: ProviderUsageStatus;
  audioDurationMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  characterCount?: number | null;
  latencyMs?: number | null;
  costMicroUsd?: number | null;
  error?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type ProviderUsageRecorder = (input: RecordProviderUsageInput) => Promise<void>;

// Build a recorder bound to a specific service-role Supabase client. Returned
// as a function so callers can pass it around without re-binding the client
// each call.
export function createProviderUsageRecorder(
  supabase: SupabaseClient<Database>,
): ProviderUsageRecorder {
  return async (input) => {
    const row: TablesInsert<"provider_usage_events"> = {
      provider: input.provider,
      operation: input.operation,
      surface: input.surface,
      status: input.status ?? "succeeded",
      model: input.model ?? null,
      household_id: input.householdId ?? null,
      user_id: input.userId ?? null,
      lesson_id: input.lessonId ?? null,
      audio_duration_ms: input.audioDurationMs ?? null,
      input_tokens: input.inputTokens ?? null,
      output_tokens: input.outputTokens ?? null,
      character_count: input.characterCount ?? null,
      latency_ms: input.latencyMs ?? null,
      cost_micro_usd: input.costMicroUsd ?? null,
      error: input.error ?? null,
      metadata: (input.metadata ?? {}) as TablesInsert<"provider_usage_events">["metadata"],
    };
    try {
      const { error } = await supabase.from("provider_usage_events").insert(row);
      if (error) {
        console.error("[provider-usage] insert failed", error.message);
      }
    } catch (err) {
      // Recorder errors must never propagate up — they would corrupt the
      // request-level error attribution. Log and move on.
      console.error("[provider-usage] insert threw", describe(err));
    }
  };
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "unknown error";
}
