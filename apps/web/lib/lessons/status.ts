import {
  isActiveLessonStatus,
  isTerminalLessonStatus,
  type LessonProcessingStatus,
} from "@reverb/domain/schemas/lesson-status";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export type LessonStatusRow = {
  id: string;
  title: string;
  createdAt: string;
  durationMs: number | null;
  processingStatus: LessonProcessingStatus;
  errorSummary: string | null;
  attemptCount: number;
  // Most recent forward motion on the pipeline — used to render "Stuck at
  // transcribing for 12 minutes" hints without re-deriving from event logs.
  startedAt: string | null;
  failedAt: string | null;
};

type RawJobRow = {
  status: LessonProcessingStatus;
  error_summary: string | null;
  attempt_count: number;
  started_at: string | null;
  failed_at: string | null;
};

// Supabase returns embedded one-to-one relations as a single object when the
// foreign key has a unique constraint, but older client versions still return
// a one-element array. We accept either shape and normalise in `pickJob`.
type RawLessonRow = {
  id: string;
  title: string;
  duration_ms: number | null;
  created_at: string;
  lesson_jobs: RawJobRow | RawJobRow[] | null;
};

function pickJob(value: RawLessonRow["lesson_jobs"]): RawJobRow | null {
  if (!value) return null;
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

type LoadOpts = {
  limit?: number;
  // When set, only return rows whose processing status is in the list. The
  // filter is applied inside the query so it runs before the limit — without
  // this, the Home module could miss an older failed lesson behind a window
  // of newer ready ones.
  statuses?: LessonProcessingStatus[];
};

const DEFAULT_LIMIT = 10;

// Fetches recent lessons for the signed-in user's household, joined to their
// processing job. Lessons without a job row are excluded via `!inner`, so the
// dev-seed `draft` lesson never shows up on the status surfaces. Returns an
// empty array when storage isn't configured rather than throwing, so callers
// can render a friendly empty state.
export async function loadLessonStatusRows(opts: LoadOpts = {}): Promise<LessonStatusRow[]> {
  const supabase = await createServerSupabaseClient();
  if (!supabase) return [];

  const limit = opts.limit ?? DEFAULT_LIMIT;

  let query = supabase
    .from("lessons")
    .select(
      "id, title, duration_ms, created_at, lesson_jobs!inner(status, error_summary, attempt_count, started_at, failed_at)",
    )
    .order("created_at", { ascending: false });

  if (opts.statuses && opts.statuses.length > 0) {
    // Dot-notation filters on the embedded resource; combined with `!inner`
    // it also drops parent lessons whose job status doesn't match.
    query = query.in("lesson_jobs.status", opts.statuses);
  }

  const { data, error } = await query.limit(limit);

  if (error || !data) return [];

  return (data as RawLessonRow[])
    .map((row): LessonStatusRow | null => {
      const job = pickJob(row.lesson_jobs);
      if (!job) return null;
      return {
        id: row.id,
        title: row.title,
        createdAt: row.created_at,
        durationMs: row.duration_ms,
        processingStatus: job.status,
        errorSummary: job.error_summary,
        attemptCount: job.attempt_count,
        startedAt: job.started_at,
        failedAt: job.failed_at,
      };
    })
    .filter((row): row is LessonStatusRow => row !== null);
}

export function isActiveRow(row: LessonStatusRow): boolean {
  return isActiveLessonStatus(row.processingStatus);
}

export function isTerminalRow(row: LessonStatusRow): boolean {
  return isTerminalLessonStatus(row.processingStatus);
}
