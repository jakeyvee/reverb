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
type LessonRow = Tables<"lessons">;
type ProfileRow = Tables<"profiles">;
type NotificationRow = Tables<"notification_events">;
type SegmentRow = Tables<"transcript_segments">;
type WordRow = Tables<"transcript_words">;
type VocabRow = Tables<"vocab_items">;
type GrammarPatternRow = Tables<"grammar_patterns">;
type DialogueClipRow = Tables<"dialogue_clips">;
type TeacherCorrectionRow = Tables<"teacher_corrections">;
type ExtractionRunRow = Tables<"extraction_runs">;
type CardRow = Tables<"cards">;
type KnownWordRow = Tables<"user_known_words">;

type Filter = { col: string; value: unknown };
type AnyRow = Record<string, unknown>;
type TableName =
  | "lesson_jobs"
  | "lesson_files"
  | "lessons"
  | "profiles"
  | "notification_events"
  | "transcript_segments"
  | "transcript_words"
  | "vocab_items"
  | "grammar_patterns"
  | "dialogue_clips"
  | "teacher_corrections"
  | "extraction_runs"
  | "cards"
  | "user_known_words";

export class FakeSupabase {
  jobs: JobRow[] = [];
  files: FileRow[] = [];
  lessons: LessonRow[] = [];
  profiles: ProfileRow[] = [];
  notifications: NotificationRow[] = [];
  transcriptSegments: SegmentRow[] = [];
  transcriptWords: WordRow[] = [];
  vocabItems: VocabRow[] = [];
  grammarPatterns: GrammarPatternRow[] = [];
  dialogueClips: DialogueClipRow[] = [];
  teacherCorrections: TeacherCorrectionRow[] = [];
  extractionRuns: ExtractionRunRow[] = [];
  cards: CardRow[] = [];
  knownWords: KnownWordRow[] = [];
  // Captures the (bucket, path, ttl) tuples requested for signed URLs, useful
  // for asserting we tried to download the right file.
  signedUrlRequests: Array<{ bucket: string; path: string; ttl: number }> = [];
  // Toggle to simulate a step failure on the n-th update to the jobs table.
  failOnNextUpdate: { whenStatus?: string; count?: number } | null = null;

  from(table: TableName) {
    switch (table) {
      case "lesson_jobs":
        return new RowsQuery(this, table, this.jobs);
      case "lesson_files":
        return new RowsQuery(this, table, this.files);
      case "lessons":
        return new RowsQuery(this, table, this.lessons);
      case "profiles":
        return new RowsQuery(this, table, this.profiles);
      case "notification_events":
        return new RowsQuery(this, table, this.notifications);
      case "transcript_segments":
        return new RowsQuery(this, table, this.transcriptSegments);
      case "transcript_words":
        return new RowsQuery(this, table, this.transcriptWords);
      case "vocab_items":
        return new RowsQuery(this, table, this.vocabItems);
      case "grammar_patterns":
        return new RowsQuery(this, table, this.grammarPatterns);
      case "dialogue_clips":
        return new RowsQuery(this, table, this.dialogueClips);
      case "teacher_corrections":
        return new RowsQuery(this, table, this.teacherCorrections);
      case "extraction_runs":
        return new RowsQuery(this, table, this.extractionRuns);
      case "cards":
        return new RowsQuery(this, table, this.cards);
      case "user_known_words":
        return new RowsQuery(this, table, this.knownWords);
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
  insertVocabItem(row: VocabRow): void {
    this.vocabItems.push({ ...row });
  }
  insertKnownWord(row: KnownWordRow): void {
    this.knownWords.push({ ...row });
  }
  job(): JobRow {
    const job = this.jobs[0];
    if (!job) throw new Error("FakeSupabase: no job row inserted");
    return job;
  }

  materializeRow(table: TableName, row: AnyRow): AnyRow {
    const now = new Date().toISOString();
    if (table === "transcript_segments") {
      return {
        id: row.id ?? randomUUID(),
        metadata: {},
        speaker_confidence: null,
        speaker_notes: null,
        speaker_low_priority: false,
        created_at: now,
        ...row,
      };
    }
    if (table === "transcript_words") {
      return {
        id: row.id ?? randomUUID(),
        confidence: null,
        created_at: now,
        ...row,
      };
    }
    if (table === "vocab_items") {
      return {
        id: row.id ?? randomUUID(),
        reading: null,
        translation: null,
        part_of_speech: null,
        example_sentence: null,
        example_translation: null,
        audio_storage_bucket: null,
        audio_storage_path: null,
        difficulty: null,
        metadata: {},
        created_at: now,
        updated_at: now,
        ...row,
      };
    }
    if (table === "grammar_patterns") {
      return {
        id: row.id ?? randomUUID(),
        description: null,
        examples: [],
        difficulty: null,
        metadata: {},
        created_at: now,
        updated_at: now,
        ...row,
      };
    }
    if (table === "dialogue_clips") {
      return {
        id: row.id ?? randomUUID(),
        segment_id: null,
        caption: null,
        translation: null,
        metadata: {},
        created_at: now,
        ...row,
      };
    }
    if (table === "teacher_corrections") {
      return {
        id: row.id ?? randomUUID(),
        segment_id: null,
        explanation: null,
        metadata: {},
        created_at: now,
        ...row,
      };
    }
    if (table === "notification_events") {
      return {
        id: row.id ?? randomUUID(),
        payload: {},
        created_at: now,
        updated_at: now,
        ...row,
      };
    }
    if (table === "cards") {
      return {
        id: row.id ?? randomUUID(),
        state: "new",
        due_at: now,
        stability: 0,
        difficulty: 0,
        reps: 0,
        lapses: 0,
        scheduled_days: 0,
        elapsed_days: 0,
        last_reviewed_at: null,
        metadata: {},
        created_at: now,
        updated_at: now,
        ...row,
      };
    }
    if (table === "user_known_words") {
      return {
        source: "self_report",
        marked_at: now,
        ...row,
      };
    }
    return { ...row };
  }

  afterDelete(table: TableName, removed: AnyRow[]): void {
    if (table === "transcript_segments") {
      const removedIds = new Set(removed.map((row) => row.id));
      this.transcriptWords = this.transcriptWords.filter(
        (word) => !removedIds.has(word.segment_id),
      );
      return;
    }
    if (table === "vocab_items") {
      // Mirror the FK cascade so tests that delete vocab_items also see cards
      // and user_known_words drop. The real schema uses
      // `on delete cascade` for both.
      const removedIds = new Set(removed.map((row) => row.id));
      this.cards = this.cards.filter((card) => !removedIds.has(card.vocab_item_id));
      this.knownWords = this.knownWords.filter(
        (entry) => !removedIds.has(entry.vocab_item_id),
      );
    }
  }
}

type Op =
  | { kind: "select" }
  | { kind: "update"; payload: AnyRow }
  | { kind: "delete" }
  | { kind: "insert"; rows: AnyRow[] }
  | { kind: "upsert"; rows: AnyRow[]; onConflict: string[]; ignoreDuplicates: boolean };

class RowsQuery<TRow extends object> {
  private filters: Filter[] = [];
  private inFilters: Array<{ col: string; values: unknown[] }> = [];
  private ordering: { col: string; ascending: boolean } | null = null;
  private rowLimit: number | null = null;
  private op: Op = { kind: "select" };

  constructor(
    private parent: FakeSupabase,
    private table: TableName,
    private rows: TRow[],
  ) {}

  select(_cols: string) {
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
  insert(payload: Partial<TRow> | Array<Partial<TRow>>) {
    this.op = {
      kind: "insert",
      rows: (Array.isArray(payload) ? payload : [payload]) as AnyRow[],
    };
    return this;
  }
  upsert(
    payload: Partial<TRow> | Array<Partial<TRow>>,
    opts: { onConflict?: string; ignoreDuplicates?: boolean } = {},
  ) {
    const onConflict = (opts.onConflict ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    this.op = {
      kind: "upsert",
      rows: (Array.isArray(payload) ? payload : [payload]) as AnyRow[],
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
    for (const f of this.inFilters) if (!f.values.includes(row[f.col])) return false;
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
      return this.rows.filter((row) => this.matchesFilters(row as AnyRow));
    }
    if (this.op.kind === "update") {
      const matches = this.rows.filter((row) => this.matchesFilters(row as AnyRow));
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
      this.parent.afterDelete(this.table, removed as AnyRow[]);
      return removed;
    }
    if (this.op.kind === "insert") {
      const inserted = this.op.rows.map((row) =>
        this.parent.materializeRow(this.table, row),
      ) as TRow[];
      this.rows.push(...inserted);
      return inserted;
    }
    if (this.op.kind === "upsert") {
      const written: TRow[] = [];
      for (const row of this.op.rows) {
        const materialized = this.parent.materializeRow(this.table, row);
        const conflict = this.findConflict(materialized, this.op.onConflict);
        if (conflict) {
          if (this.op.ignoreDuplicates) continue;
          Object.assign(conflict, materialized);
          written.push(conflict);
          continue;
        }
        const clone = materialized as TRow;
        this.rows.push(clone);
        written.push(clone);
      }
      return written;
    }
    return [];
  }

  private findConflict(candidate: AnyRow, cols: string[]): TRow | undefined {
    if (cols.length === 0) return undefined;
    return this.rows.find((existing) =>
      cols.every((col) => (existing as AnyRow)[col] === candidate[col]),
    );
  }

  private maybeThrowSimulatedFailure(job: JobRow | undefined): void {
    const fail = this.parent.failOnNextUpdate;
    if (!fail) return;
    if (this.op.kind !== "update") return;
    if (fail.whenStatus && this.op.payload.status !== fail.whenStatus) return;
    this.parent.failOnNextUpdate = null;
    void job;
    throw new Error("simulated provider failure");
  }
}
