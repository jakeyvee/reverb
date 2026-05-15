import {
  isActiveLessonStatus,
  isTerminalLessonStatus,
  type LessonProcessingStatus,
} from "@reverb/domain/schemas/lesson-status";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import {
  mapLessonStatusRow,
  type LessonStatusRow,
  type RawLessonRow,
} from "@/lib/lessons/status-mapping";

export type { LessonStatusRow } from "@/lib/lessons/status-mapping";

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
// processing job and counts of extracted content. Lessons without a job row
// are excluded via `!inner`, so the dev-seed `draft` lesson never shows up on
// the status surfaces. Returns an empty array when storage isn't configured
// rather than throwing, so callers can render a friendly empty state.
export async function loadLessonStatusRows(opts: LoadOpts = {}): Promise<LessonStatusRow[]> {
  const supabase = await createServerSupabaseClient();
  if (!supabase) return [];

  const limit = opts.limit ?? DEFAULT_LIMIT;

  let query = supabase
    .from("lessons")
    .select(
      "id, title, duration_ms, created_at," +
        " lesson_jobs!inner(status, error_summary, attempt_count, started_at, failed_at)," +
        " vocab_items(count), teacher_corrections(count), grammar_patterns(count)",
    )
    .order("created_at", { ascending: false });

  if (opts.statuses && opts.statuses.length > 0) {
    // Dot-notation filters on the embedded resource; combined with `!inner`
    // it also drops parent lessons whose job status doesn't match.
    query = query.in("lesson_jobs.status", opts.statuses);
  }

  const { data, error } = await query.limit(limit);

  if (error || !data) return [];

  // Supabase's generated types don't model the `relation(count)` aggregate, so
  // the inferred row type collapses to GenericStringError. Cast via unknown to
  // the shape we actually pulled.
  return (data as unknown as RawLessonRow[])
    .map(mapLessonStatusRow)
    .filter((row): row is LessonStatusRow => row !== null);
}

export function isActiveRow(row: LessonStatusRow): boolean {
  return isActiveLessonStatus(row.processingStatus);
}

export function isTerminalRow(row: LessonStatusRow): boolean {
  return isTerminalLessonStatus(row.processingStatus);
}
