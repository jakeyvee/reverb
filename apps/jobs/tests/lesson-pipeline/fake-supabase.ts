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

type Filter = { col: string; value: unknown };

export class FakeSupabase {
  jobs: JobRow[] = [];
  files: FileRow[] = [];
  // Captures the (bucket, path, ttl) tuples requested for signed URLs, useful
  // for asserting we tried to download the right file.
  signedUrlRequests: Array<{ bucket: string; path: string; ttl: number }> = [];
  // Toggle to simulate a step failure on the n-th update to the jobs table.
  failOnNextUpdate: { whenStatus?: string; count?: number } | null = null;

  from(table: string) {
    if (table === "lesson_jobs") return new JobsQuery(this);
    if (table === "lesson_files") return new FilesQuery(this);
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
