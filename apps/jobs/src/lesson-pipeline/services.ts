// Dependency-injection seam for the lesson pipeline. Production code uses
// `defaultPipelineServices()` to wire the real provider adapters; tests pass a
// stub so they can exercise the orchestrator without hitting Groq/Anthropic.
import {
  inferDiarizationWithAnthropic,
  inferExtractionWithAnthropic,
  transcribeAudioWithGroq,
  type InferDiarizationInput,
  type InferDiarizationResult,
  type InferExtractionInput,
  type InferExtractionResult,
  type TranscribeAudioInput,
  type TranscribeAudioResult,
} from "@reverb/ai";
import { defaultLessonEmailer, type LessonEmailer } from "@reverb/email";
import type { MediaToolOptions } from "./media.js";
import type {
  EmailRecipientResolver,
  VincentEmailResolver,
} from "./notifications.js";
import type { ServiceClient } from "./state.js";

export type Transcriber = (input: TranscribeAudioInput) => Promise<TranscribeAudioResult>;
export type Diarizer = (input: InferDiarizationInput) => Promise<InferDiarizationResult>;
export type Extractor = (input: InferExtractionInput) => Promise<InferExtractionResult>;

export type PipelineServices = {
  transcribe: Transcriber;
  diarize: Diarizer;
  extract: Extractor;
  // Optional ffmpeg/ffprobe overrides for the clip-generation step. Production
  // leaves it unset (the helpers in @reverb/media auto-resolve the static
  // binary); tests inject a fake runner so the orchestrator can be exercised
  // without spawning a real ffmpeg.
  mediaTools?: MediaToolOptions;
  // Send the lesson_ready / lesson_failed emails through Resend (production)
  // or a capturing stub (tests).
  emailer: LessonEmailer;
  // Resolve a user's email from a Supabase auth user id. Production uses the
  // service-role admin API; tests inject a map-backed stub so they don't have
  // to model auth.admin in FakeSupabase.
  resolveRecipientEmail: EmailRecipientResolver;
  // Vincent's address for lesson_failed emails. Sourced from
  // VINCENT_UPLOAD_EMAIL in production; returned by a constant in tests.
  resolveVincentEmail: VincentEmailResolver;
};

// Production Supabase auth admin lookup. Service role required — the worker
// already uses it, so this just borrows the existing client. Failures
// (deleted user, missing auth.admin surface, transient error) collapse to a
// `null` return so the orchestrator can log and skip rather than crash the
// pipeline mid-finalisation — per VOL-125's "email failures must not roll
// back lesson processing" acceptance criterion.
export function createAuthAdminRecipientResolver(
  supabase: ServiceClient,
): EmailRecipientResolver {
  return async (userId) => {
    try {
      const { data, error } = await supabase.auth.admin.getUserById(userId);
      if (error) return null;
      return data.user?.email ?? null;
    } catch {
      return null;
    }
  };
}

export function defaultVincentEmailResolver(): VincentEmailResolver {
  return () => {
    const raw = process.env.VINCENT_UPLOAD_EMAIL?.trim();
    if (!raw) return null;
    return raw.toLowerCase();
  };
}

export function defaultPipelineServices(supabase: ServiceClient): PipelineServices {
  return {
    transcribe: transcribeAudioWithGroq,
    diarize: inferDiarizationWithAnthropic,
    extract: inferExtractionWithAnthropic,
    emailer: defaultLessonEmailer(),
    resolveRecipientEmail: createAuthAdminRecipientResolver(supabase),
    resolveVincentEmail: defaultVincentEmailResolver(),
  };
}
