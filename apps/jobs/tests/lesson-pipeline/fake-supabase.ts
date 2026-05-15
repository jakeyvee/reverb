// Minimal fake of the surface area the lesson pipeline touches. It models
// just enough of supabase-js's chainable query builder to drive the
// orchestrator end-to-end without a real Supabase instance.
//
// Keeping the fake in tests/ rather than dressing it up as a full mock keeps
// it obvious which paths are exercised. If a future code change reaches for a
// new method, the fake will throw at test time and we'll add it explicitly.
import { randomUUID } from "node:crypto";
import type { Tables } from "@reverb/db/types";

type JobRow = Tables<"lesson_jobs">;
type FileRow = Tables<"lesson_files">;
type SegmentRow = Tables<"transcript_segments">;
type WordRow = Tables<"transcript_words">;
type SegmentInsert = Omit<SegmentRow, "id" | "created_at" | "metadata"> & {
  id?: string;
  metadata?: SegmentRow["metadata"];
  created_at?: string;
};
type WordInsert = Omit<WordRow, "id" | "created_at"> & {
  id?: string;
  created_at?: string;
};

type Filter = { col: string; value: unknown };

export class FakeSupabase {
  jobs: JobRow[] = [];
  files: FileRow[] = [];
  transcriptSegments: SegmentRow[] = [];
  transcriptWords: WordRow[] = [];
  // Captures the (bucket, path, ttl) tuples requested for signed URLs, useful
  // for asserting we tried to download the right file.
  signedUrlRequests: Array<{ bucket: string; path: string; ttl: number }> = [];
  // Toggle to simulate a step failure on the n-th update to the jobs table.
  failOnNextUpdate: { whenStatus?: string; count?: number } | null = null;

  from(table: string) {
    if (table === "lesson_jobs") return new JobsQuery(this);
    if (table === "lesson_files") return new FilesQuery(this);
    if (table === "transcript_segments") return new TranscriptSegmentsQuery(this);
    if (table === "transcript_words") return new TranscriptWordsQuery(this);
    throw new Error(`FakeSupabase: unsupported table ${table}`);
  }

  storage = {
    from: (bucket: string) => ({
      createSignedUrl: async (path: string, ttl: number) => {
        this.signedUrlRequests.push({ bucket, path, ttl });
        return { data: { signedUrl: `https://fake/${bucket}/${path}?ttl=${ttl}` }, error: null };
      },
    }),
  };

  // Convenience helpers for setup.
  insertJob(row: JobRow): void {
    this.jobs.push({ ...row });
  }
  insertFile(row: FileRow): void {
    this.files.push({ ...row });
  }
  job(): JobRow {
    const job = this.jobs[0];
    if (!job) throw new Error("FakeSupabase: no job row inserted");
    return job;
  }
}

class JobsQuery {
  private filters: Filter[] = [];
  private updatePayload: Partial<JobRow> | null = null;
  private selectAfterUpdate = false;
  private isUpdate = false;

  constructor(private parent: FakeSupabase) {}

  select(_cols: string) {
    if (this.isUpdate) {
      this.selectAfterUpdate = true;
    }
    return this;
  }
  eq(col: string, value: unknown) {
    this.filters.push({ col, value });
    return this;
  }
  update(payload: Partial<JobRow>) {
    this.isUpdate = true;
    this.updatePayload = payload;
    return this;
  }
  single(): Promise<{ data: JobRow | null; error: null | { message: string } }> {
    return this.execSingle();
  }
  // Some call sites omit `.single()` (the upload action's trigger_run_id
  // tag update). Awaiting the builder itself resolves with `{ error }`.
  then<TResult1 = { error: null | { message: string } }>(
    resolve: (value: { error: null | { message: string } }) => TResult1,
  ): Promise<TResult1> {
    return this.execVoid().then(resolve);
  }

  private async execSingle() {
    const matches = this.parent.jobs.filter((j) =>
      this.filters.every((f) => (j as unknown as Record<string, unknown>)[f.col] === f.value),
    );
    if (this.isUpdate && this.updatePayload) {
      this.maybeThrowSimulatedFailure(matches[0]);
      for (const job of matches) Object.assign(job, this.updatePayload);
    }
    if (matches.length !== 1) return { data: null, error: { message: "not found" } };
    if (this.isUpdate && !this.selectAfterUpdate) {
      return { data: null, error: null } as never;
    }
    return { data: { ...matches[0]! }, error: null };
  }

  private async execVoid() {
    const matches = this.parent.jobs.filter((j) =>
      this.filters.every((f) => (j as unknown as Record<string, unknown>)[f.col] === f.value),
    );
    if (this.isUpdate && this.updatePayload) {
      this.maybeThrowSimulatedFailure(matches[0]);
      for (const job of matches) Object.assign(job, this.updatePayload);
    }
    return { error: null };
  }

  private maybeThrowSimulatedFailure(job: JobRow | undefined): void {
    const fail = this.parent.failOnNextUpdate;
    if (!fail) return;
    if (fail.whenStatus && this.updatePayload?.status !== fail.whenStatus) return;
    this.parent.failOnNextUpdate = null;
    void job; // currently unused; reserved for richer trigger conditions
    throw new Error("simulated provider failure");
  }
}

class FilesQuery {
  private filters: Filter[] = [];
  private ordering: { col: string; ascending: boolean } | null = null;
  private rowLimit: number | null = null;

  constructor(private parent: FakeSupabase) {}

  select(_cols: string) {
    return this;
  }
  eq(col: string, value: unknown) {
    this.filters.push({ col, value });
    return this;
  }
  order(col: string, opts: { ascending: boolean }) {
    this.ordering = { col, ascending: opts.ascending };
    return this;
  }
  limit(n: number) {
    this.rowLimit = n;
    return this;
  }
  async maybeSingle() {
    let rows = this.parent.files.filter((r) =>
      this.filters.every((f) => (r as unknown as Record<string, unknown>)[f.col] === f.value),
    );
    if (this.ordering) {
      const { col, ascending } = this.ordering;
      rows = [...rows].sort((a, b) => {
        const av = String((a as Record<string, unknown>)[col]);
        const bv = String((b as Record<string, unknown>)[col]);
        return (ascending ? 1 : -1) * av.localeCompare(bv);
      });
    }
    if (this.rowLimit !== null) rows = rows.slice(0, this.rowLimit);
    return { data: rows[0] ?? null, error: null };
  }
}

// Shared insert/delete/update/select builder for the transcript_segments
// table. Models just enough of the supabase-js builder for the lesson pipeline
// (transcribing's delete+insert+select-after-insert and diarizing's
// select+update). Awaiting the builder runs whichever mode was selected.
class TranscriptSegmentsQuery {
  private filters: Filter[] = [];
  private mode: "select" | "insert" | "delete" | "update" | null = null;
  private insertRows: SegmentInsert[] = [];
  private updatePayload: Partial<SegmentRow> | null = null;
  private selectInserted = false;
  private ordering: { col: string; ascending: boolean } | null = null;

  constructor(private parent: FakeSupabase) {}

  select(_cols: string) {
    if (this.mode === "insert") {
      this.selectInserted = true;
      return this;
    }
    if (this.mode === null) this.mode = "select";
    return this;
  }

  insert(rows: SegmentInsert | SegmentInsert[]) {
    this.mode = "insert";
    this.insertRows = Array.isArray(rows) ? rows : [rows];
    return this;
  }

  delete() {
    this.mode = "delete";
    return this;
  }

  update(payload: Partial<SegmentRow>) {
    this.mode = "update";
    this.updatePayload = payload;
    return this;
  }

  eq(col: string, value: unknown) {
    this.filters.push({ col, value });
    return this;
  }

  order(col: string, opts: { ascending: boolean }) {
    this.ordering = { col, ascending: opts.ascending };
    return this;
  }

  // Awaiting the builder triggers the operation. supabase-js returns
  // `{ data, error }` either inline (insert/select) or empty (delete/update).
  then<TResult>(
    resolve: (value: { data: SegmentRow[] | null; error: null | { message: string } }) => TResult,
  ): Promise<TResult> {
    return this.exec().then(resolve);
  }

  private matches(row: SegmentRow): boolean {
    return this.filters.every(
      (f) => (row as unknown as Record<string, unknown>)[f.col] === f.value,
    );
  }

  private async exec() {
    if (this.mode === "delete") {
      const remaining: SegmentRow[] = [];
      const removed: SegmentRow[] = [];
      for (const row of this.parent.transcriptSegments) {
        if (this.matches(row)) removed.push(row);
        else remaining.push(row);
      }
      this.parent.transcriptSegments = remaining;
      // Cascade-on-delete to the words table.
      const removedIds = new Set(removed.map((r) => r.id));
      this.parent.transcriptWords = this.parent.transcriptWords.filter(
        (w) => !removedIds.has(w.segment_id),
      );
      return { data: null, error: null } as { data: SegmentRow[] | null; error: null };
    }

    if (this.mode === "insert") {
      const created: SegmentRow[] = this.insertRows.map((row) => ({
        id: row.id ?? randomUUID(),
        lesson_id: row.lesson_id,
        segment_index: row.segment_index,
        start_ms: row.start_ms,
        end_ms: row.end_ms,
        speaker: row.speaker ?? null,
        speaker_confidence: row.speaker_confidence ?? null,
        speaker_notes: row.speaker_notes ?? null,
        speaker_low_priority: row.speaker_low_priority ?? false,
        language: row.language ?? null,
        text: row.text,
        metadata: row.metadata ?? {},
        created_at: row.created_at ?? new Date().toISOString(),
      }));
      this.parent.transcriptSegments.push(...created);
      if (this.selectInserted) {
        return { data: created, error: null };
      }
      return { data: null, error: null };
    }

    if (this.mode === "update" && this.updatePayload) {
      for (const row of this.parent.transcriptSegments) {
        if (!this.matches(row)) continue;
        Object.assign(row, this.updatePayload);
      }
      return { data: null, error: null };
    }

    if (this.mode === "select") {
      let rows = this.parent.transcriptSegments.filter((r) => this.matches(r));
      if (this.ordering) {
        const { col, ascending } = this.ordering;
        rows = [...rows].sort((a, b) => {
          const av = (a as unknown as Record<string, unknown>)[col];
          const bv = (b as unknown as Record<string, unknown>)[col];
          if (typeof av === "number" && typeof bv === "number") {
            return (ascending ? 1 : -1) * (av - bv);
          }
          return (ascending ? 1 : -1) * String(av).localeCompare(String(bv));
        });
      }
      return { data: rows.map((r) => ({ ...r })), error: null };
    }

    throw new Error("FakeSupabase: transcript_segments operation not implemented");
  }
}

class TranscriptWordsQuery {
  private mode: "insert" | null = null;
  private insertRows: WordInsert[] = [];

  constructor(private parent: FakeSupabase) {}

  insert(rows: WordInsert | WordInsert[]) {
    this.mode = "insert";
    this.insertRows = Array.isArray(rows) ? rows : [rows];
    return this;
  }

  then<TResult>(
    resolve: (value: { error: null | { message: string } }) => TResult,
  ): Promise<TResult> {
    return this.exec().then(resolve);
  }

  private async exec() {
    if (this.mode === "insert") {
      const created: WordRow[] = this.insertRows.map((row) => ({
        id: row.id ?? randomUUID(),
        segment_id: row.segment_id,
        lesson_id: row.lesson_id,
        word_index: row.word_index,
        start_ms: row.start_ms,
        end_ms: row.end_ms,
        text: row.text,
        confidence: row.confidence ?? null,
        created_at: row.created_at ?? new Date().toISOString(),
      }));
      this.parent.transcriptWords.push(...created);
      return { error: null };
    }
    throw new Error("FakeSupabase: transcript_words op not implemented");
  }
}
