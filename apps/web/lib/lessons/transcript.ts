import { LESSON_AUDIO_BUCKET } from "@reverb/domain/schemas/upload";
import { type LessonProcessingStatus } from "@reverb/domain/schemas/lesson-status";
import { createServerSupabaseClient } from "@/lib/supabase/server";

// 10 minutes is comfortably longer than a typical detail-page session without
// over-extending the credential. The page is server-rendered, so every request
// mints a fresh URL anyway.
const AUDIO_SIGNED_URL_TTL_SECONDS = 60 * 10;

export type TranscriptSegmentRow = {
  id: string;
  index: number;
  startMs: number;
  endMs: number;
  speaker: string | null;
  language: string | null;
  text: string;
};

export type TranscriptAudio = {
  signedUrl: string;
  mimeType: string | null;
};

export type LessonTranscriptView = {
  lesson: {
    id: string;
    title: string;
    description: string | null;
    durationMs: number | null;
    createdAt: string;
    sourceLanguage: string | null;
    targetLanguage: string | null;
  };
  job: {
    status: LessonProcessingStatus;
    errorSummary: string | null;
    attemptCount: number;
    startedAt: string | null;
    failedAt: string | null;
  } | null;
  segments: TranscriptSegmentRow[];
  audio: TranscriptAudio | null;
};

export type LoadTranscriptResult =
  | { ok: true; view: LessonTranscriptView }
  | { ok: false; reason: "not-configured" | "not-found" };

// Loads everything the Lesson Detail transcript tab needs in a single roundtrip
// plan: lesson row, processing job, ordered transcript segments, and a signed
// URL for the source audio when present. Reads go through the authenticated
// client so RLS enforces household scoping — we never trust the URL lessonId.
export async function loadLessonTranscript(lessonId: string): Promise<LoadTranscriptResult> {
  const supabase = await createServerSupabaseClient();
  if (!supabase) return { ok: false, reason: "not-configured" };

  const { data: lessonRow, error: lessonError } = await supabase
    .from("lessons")
    .select("id, title, description, duration_ms, created_at, source_language, target_language")
    .eq("id", lessonId)
    .maybeSingle();

  if (lessonError || !lessonRow) {
    return { ok: false, reason: "not-found" };
  }

  // Job, segments, and the audio file are independent reads — fire in parallel.
  // The job row may be absent for a freshly-created lesson; the page still
  // renders the lesson metadata and a "transcript not ready" state.
  const [{ data: jobRow }, { data: segmentRows }, { data: audioFile }] = await Promise.all([
    supabase
      .from("lesson_jobs")
      .select("status, error_summary, attempt_count, started_at, failed_at")
      .eq("lesson_id", lessonId)
      .maybeSingle(),
    supabase
      .from("transcript_segments")
      .select("id, segment_index, start_ms, end_ms, speaker, language, text")
      .eq("lesson_id", lessonId)
      .order("segment_index", { ascending: true }),
    supabase
      .from("lesson_files")
      .select("storage_bucket, storage_path, mime_type")
      .eq("lesson_id", lessonId)
      .eq("kind", "audio_source")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);

  const segments: TranscriptSegmentRow[] = (segmentRows ?? []).map((row) => ({
    id: row.id,
    index: row.segment_index,
    startMs: row.start_ms,
    endMs: row.end_ms,
    speaker: row.speaker,
    language: row.language,
    text: row.text,
  }));

  let audio: TranscriptAudio | null = null;
  if (audioFile && audioFile.storage_bucket === LESSON_AUDIO_BUCKET) {
    const { data: signed } = await supabase.storage
      .from(audioFile.storage_bucket)
      .createSignedUrl(audioFile.storage_path, AUDIO_SIGNED_URL_TTL_SECONDS);
    if (signed?.signedUrl) {
      audio = { signedUrl: signed.signedUrl, mimeType: audioFile.mime_type };
    }
  }

  return {
    ok: true,
    view: {
      lesson: {
        id: lessonRow.id,
        title: lessonRow.title,
        description: lessonRow.description,
        durationMs: lessonRow.duration_ms,
        createdAt: lessonRow.created_at,
        sourceLanguage: lessonRow.source_language,
        targetLanguage: lessonRow.target_language,
      },
      job: jobRow
        ? {
            status: jobRow.status,
            errorSummary: jobRow.error_summary,
            attemptCount: jobRow.attempt_count,
            startedAt: jobRow.started_at,
            failedAt: jobRow.failed_at,
          }
        : null,
      segments,
      audio,
    },
  };
}
