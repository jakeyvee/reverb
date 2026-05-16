import type { LessonProcessingStatus } from "@reverb/domain/schemas/lesson-status";

// Shape mirrors what Supabase returns from the archive query — see status.ts.
// The mappers below are intentionally pure (no I/O, no auth) so they're cheap
// to test against fixtures and easy to evolve when the wire format shifts.

export type RawJobRow = {
  status: LessonProcessingStatus;
  error_summary: string | null;
  attempt_count: number;
  started_at: string | null;
  failed_at: string | null;
};

export type RawCount = { count: number };

export type RawLessonRow = {
  id: string;
  title: string;
  duration_ms: number | null;
  created_at: string;
  // Embedded one-to-one — Supabase normalises this to a single object, but
  // older client versions still return a one-element array.
  lesson_jobs: RawJobRow | RawJobRow[] | null;
  // `relation(count)` aggregates arrive as a single-element array.
  vocab_items: RawCount[] | null;
  teacher_corrections: RawCount[] | null;
  grammar_patterns: RawCount[] | null;
};

export type LessonStatusRow = {
  id: string;
  title: string;
  createdAt: string;
  durationMs: number | null;
  processingStatus: LessonProcessingStatus;
  errorSummary: string | null;
  attemptCount: number;
  startedAt: string | null;
  failedAt: string | null;
  vocabCount: number;
  correctionCount: number;
  grammarPatternCount: number;
};

export function pickJob(value: RawLessonRow["lesson_jobs"]): RawJobRow | null {
  if (!value) return null;
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

export function pickCount(value: RawCount[] | null | undefined): number {
  if (!value || value.length === 0) return 0;
  return value[0]?.count ?? 0;
}

// Returns null when the row lacks a processing job — those rows belong to
// upstream surfaces (e.g. the draft seed lesson) that aren't part of the
// processing/archive flow.
export function mapLessonStatusRow(row: RawLessonRow): LessonStatusRow | null {
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
    vocabCount: pickCount(row.vocab_items),
    correctionCount: pickCount(row.teacher_corrections),
    grammarPatternCount: pickCount(row.grammar_patterns),
  };
}
