// Minimal fake of the surface area the lesson pipeline touches. It models
// just enough of supabase-js's chainable query builder to drive the
// orchestrator end-to-end without a real Supabase instance.
//
// Keeping the fake in tests/ rather than dressing it up as a full mock keeps
// it obvious which paths are exercised. If a future code change reaches for a
// new method, the fake will throw at test time and we'll add it explicitly.
import type { Tables } from "@reverb/db/types";

type JobRow = Tables<"lesson_jobs">;
type FileRow = Tables<"lesson_files">;
type LessonRow = Tables<"lessons">;
type ProfileRow = Tables<"profiles">;
type NotificationRow = Tables<"notification_events">;
type TranscriptSegmentRow = Tables<"transcript_segments">;
type ExtractionRunRow = Tables<"extraction_runs">;

type Filter = { col: string; value: unknown };

type AnyRow = Record<string, unknown>;

export class FakeSupabase {
  jobs: JobRow[] = [];
  files: FileRow[] = [];
  lessons: LessonRow[] = [];
  profiles: ProfileRow[] = [];
  notifications: NotificationRow[] = [];
  transcriptSegments: TranscriptSegmentRow[] = [];
  extractionRuns: ExtractionRunRow[] = [];
  // Captures the (bucket, path, ttl) tuples requested for signed URLs, useful
  // for asserting we tried to download the right file.
  signedUrlRequests: Array<{ bucket: string; path: string; ttl: number }> = [];
  // Toggle to simulate a step failure on the n-th update to the jobs table.
  failOnNextUpdate: { whenStatus?: string; count?: number } | null = null;

  from(table: string) {
    switch (table) {
      case "lesson_jobs":
        return new RowsQuery<JobRow>(this, this.jobs, this);
      case "lesson_files":
        return new RowsQuery<FileRow>(this, this.files, this);
      case "lessons":
        return new RowsQuery<LessonRow>(this, this.lessons, this);
      case "profiles":
        return new RowsQuery<ProfileRow>(this, this.profiles, this);
      case "notification_events":
        return new RowsQuery<NotificationRow>(this, this.notifications, this);
      case "transcript_segments":
        return new RowsQuery<TranscriptSegmentRow>(this, this.transcriptSegments, this);
      case "extraction_runs":
        return new RowsQuery<ExtractionRunRow>(this, this.extractionRuns, this);
      default:
        throw new Error(`FakeSupabase: unsupported table ${table}`);
    }
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
  insertLesson(row: LessonRow): void {
    this.lessons.push({ ...row });
  }
  insertProfile(row: ProfileRow): void {
    this.profiles.push({ ...row });
  }
  job(): JobRow {
    const job = this.jobs[0];
    if (!job) throw new Error("FakeSupabase: no job row inserted");
    return job;
  }
}

type Op =
  | { kind: "select" }
  | { kind: "update"; payload: AnyRow }
  | { kind: "delete" }
  | { kind: "insert"; rows: AnyRow[] }
  | { kind: "upsert"; rows: AnyRow[]; onConflict: string[]; ignoreDuplicates: boolean };

class RowsQuery<TRow extends AnyRow> {
  private filters: Filter[] = [];
  private inFilters: Array<{ col: string; values: unknown[] }> = [];
  private ordering: { col: string; ascending: boolean } | null = null;
  private rowLimit: number | null = null;
  private selectAfter = false;
  private op: Op = { kind: "select" };

  constructor(
    private parent: FakeSupabase,
    private rows: TRow[],
    private rootForFailure: FakeSupabase,
  ) {}

  select(_cols: string) {
    this.selectAfter = true;
    return this;
  }
  eq(col: string, value: unknown) {
    this.filters.push({ col, value });
    return this;
  }
  in(col: string, values: unknown[]) {
    this.inFilters.push({ col, values });
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
  update(payload: Partial<TRow>) {
    this.op = { kind: "update", payload: payload as AnyRow };
    return this;
  }
  delete() {
    this.op = { kind: "delete" };
    return this;
  }
  insert(payload: TRow | TRow[]) {
    const rows = Array.isArray(payload) ? payload : [payload];
    this.op = { kind: "insert", rows: rows as AnyRow[] };
    return this;
  }
  upsert(payload: TRow | TRow[], opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
    const rows = Array.isArray(payload) ? payload : [payload];
    const onConflict = (opts.onConflict ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    this.op = {
      kind: "upsert",
      rows: rows as AnyRow[],
      onConflict,
      ignoreDuplicates: opts.ignoreDuplicates ?? false,
    };
    return this;
  }
  async single(): Promise<{ data: TRow | null; error: null | { message: string } }> {
    const matches = this.applyOp();
    if (matches.length !== 1) return { data: null, error: { message: "not found" } };
    return { data: { ...matches[0]! }, error: null };
  }
  async maybeSingle(): Promise<{ data: TRow | null; error: null | { message: string } }> {
    let matches = this.applyOp();
    if (this.ordering) matches = this.sortRows(matches);
    if (this.rowLimit !== null) matches = matches.slice(0, this.rowLimit);
    return { data: matches[0] ? { ...matches[0]! } : null, error: null };
  }

  // Awaiting the builder directly resolves to the "no .single() requested"
  // path: for selects that returns the array, for mutations it returns the
  // matched (or written) rows so callers using `.select()` get them back.
  then<TResult = { data: TRow[] | null; error: null | { message: string } }>(
    resolve: (value: { data: TRow[] | null; error: null | { message: string } }) => TResult,
  ): Promise<TResult> {
    return Promise.resolve()
      .then(() => {
        let matches = this.applyOp();
        if (this.ordering) matches = this.sortRows(matches);
        if (this.rowLimit !== null) matches = matches.slice(0, this.rowLimit);
        return { data: matches.map((m) => ({ ...m })), error: null } as {
          data: TRow[] | null;
          error: null | { message: string };
        };
      })
      .then(resolve);
  }

  private matchesFilters(row: AnyRow): boolean {
    for (const f of this.filters) if (row[f.col] !== f.value) return false;
    for (const f of this.inFilters) {
      if (!f.values.includes(row[f.col])) return false;
    }
    return true;
  }

  private sortRows(rows: TRow[]): TRow[] {
    if (!this.ordering) return rows;
    const { col, ascending } = this.ordering;
    return [...rows].sort((a, b) => {
      const av = String((a as AnyRow)[col]);
      const bv = String((b as AnyRow)[col]);
      return (ascending ? 1 : -1) * av.localeCompare(bv);
    });
  }

  private applyOp(): TRow[] {
    if (this.op.kind === "select") {
      return this.rows.filter((r) => this.matchesFilters(r as AnyRow));
    }
    if (this.op.kind === "update") {
      const matches = this.rows.filter((r) => this.matchesFilters(r as AnyRow));
      this.maybeThrowSimulatedFailure(matches[0] as JobRow | undefined);
      for (const row of matches) Object.assign(row, this.op.payload);
      return matches;
    }
    if (this.op.kind === "delete") {
      const survivors: TRow[] = [];
      const removed: TRow[] = [];
      for (const row of this.rows) {
        if (this.matchesFilters(row as AnyRow)) removed.push(row);
        else survivors.push(row);
      }
      this.rows.length = 0;
      this.rows.push(...survivors);
      return removed;
    }
    if (this.op.kind === "insert") {
      const inserted: TRow[] = [];
      for (const row of this.op.rows) {
        const clone = { ...row } as TRow;
        this.rows.push(clone);
        inserted.push(clone);
      }
      return inserted;
    }
    if (this.op.kind === "upsert") {
      const inserted: TRow[] = [];
      for (const row of this.op.rows) {
        const conflict = this.findConflict(row, this.op.onConflict);
        if (conflict) {
          if (this.op.ignoreDuplicates) continue;
          Object.assign(conflict, row);
          inserted.push(conflict);
          continue;
        }
        const clone = { ...row } as TRow;
        this.rows.push(clone);
        inserted.push(clone);
      }
      return inserted;
    }
    return [];
  }

  private findConflict(candidate: AnyRow, cols: string[]): TRow | undefined {
    if (cols.length === 0) return undefined;
    return this.rows.find((existing) =>
      cols.every((c) => (existing as AnyRow)[c] === candidate[c]),
    );
  }

  private maybeThrowSimulatedFailure(job: JobRow | undefined): void {
    const fail = this.rootForFailure.failOnNextUpdate;
    if (!fail) return;
    if (this.op.kind !== "update") return;
    if (fail.whenStatus && this.op.payload.status !== fail.whenStatus) return;
    this.rootForFailure.failOnNextUpdate = null;
    void job;
    throw new Error("simulated provider failure");
  }
}
