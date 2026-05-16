// Minimal fake of the surface area the lesson pipeline touches. It models
// just enough of supabase-js's chainable query builder to drive the
// orchestrator end-to-end without a real Supabase instance.
//
// Keeping the fake in tests/ rather than dressing it up as a full mock keeps
// it obvious which paths are exercised. If a future code change reaches for a
// new method, the fake will throw at test time and we'll add it explicitly.
import { Buffer } from "node:buffer";
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
type GrammarExerciseRow = Tables<"grammar_exercises">;
type DialogueClipRow = Tables<"dialogue_clips">;
type TeacherCorrectionRow = Tables<"teacher_corrections">;
type ExtractionRunRow = Tables<"extraction_runs">;
type CardRow = Tables<"cards">;
type KnownWordRow = Tables<"user_known_words">;
type TtsAssetRow = Tables<"tts_assets">;

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
  | "grammar_exercises"
  | "dialogue_clips"
  | "teacher_corrections"
  | "extraction_runs"
  | "cards"
  | "user_known_words"
  | "tts_assets";

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
  grammarExercises: GrammarExerciseRow[] = [];
  dialogueClips: DialogueClipRow[] = [];
  teacherCorrections: TeacherCorrectionRow[] = [];
  extractionRuns: ExtractionRunRow[] = [];
  cards: CardRow[] = [];
  knownWords: KnownWordRow[] = [];
  ttsAssets: TtsAssetRow[] = [];
  // Captures the (bucket, path, ttl) tuples requested for signed URLs, useful
  // for asserting we tried to download the right file.
  signedUrlRequests: Array<{ bucket: string; path: string; ttl: number }> = [];
  // Object body served by `storage.from(bucket).download(path)` calls. When a
  // test stages a download (e.g. for clip materialization), it preloads bytes
  // here keyed by `${bucket}:${path}`. Unknown keys return a 404-shaped error.
  storageObjects: Map<string, Buffer> = new Map();
  // Captures the (bucket, path, bytes, byteSize, contentType, upsert) tuples
  // for every uploaded object. `bytes` is used by clip-materialization tests;
  // `byteSize` is used by TTS tests.
  storageUploads: Array<{
    bucket: string;
    path: string;
    bytes: Buffer;
    byteSize: number;
    contentType: string | undefined;
    upsert: boolean | undefined;
  }> = [];
  // Toggleable upload failure, used to model a transient storage 503.
  failNextUpload: { bucket?: string } | null = null;
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
      case "grammar_exercises":
        return new RowsQuery(this, table, this.grammarExercises);
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
      case "tts_assets":
        return new RowsQuery(this, table, this.ttsAssets);
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
      download: async (path: string) => {
        const key = `${bucket}:${path}`;
        const body = this.storageObjects.get(key);
        if (!body) {
          return { data: null, error: { message: `object not found: ${key}` } };
        }
        return {
          data: {
            arrayBuffer: async () =>
              body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
          },
          error: null,
        };
      },
      upload: async (
        path: string,
        body: Buffer | Uint8Array | Blob | ArrayBuffer,
        opts?: { contentType?: string; upsert?: boolean },
      ) => {
        if (
          this.failNextUpload &&
          (!this.failNextUpload.bucket || this.failNextUpload.bucket === bucket)
        ) {
          this.failNextUpload = null;
          return { data: null, error: { message: "simulated upload failure" } };
        }
        const buffer = Buffer.isBuffer(body)
          ? body
          : body instanceof Uint8Array
            ? Buffer.from(body)
            : body instanceof ArrayBuffer
              ? Buffer.from(body)
              : Buffer.alloc(0);
        this.storageUploads.push({
          bucket,
          path,
          bytes: buffer,
          byteSize: byteLength(body),
          contentType: opts?.contentType,
          upsert: opts?.upsert,
        });
        return { data: { id: path, path, fullPath: `${bucket}/${path}` }, error: null };
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
  insertTtsAsset(row: TtsAssetRow): void {
    this.ttsAssets.push({ ...row });
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
    if (table === "grammar_exercises") {
      return {
        id: row.id ?? randomUUID(),
        lesson_id: null,
        grammar_pattern_id: null,
        choices: [],
        accepted_answers: [],
        explanation: null,
        prompt_version: null,
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
    if (table === "extraction_runs") {
      return {
        id: row.id ?? randomUUID(),
        status: "succeeded",
        model: null,
        prompt_version: null,
        input: {},
        output: {},
        error: null,
        cost_cents: null,
        started_at: null,
        finished_at: null,
        version: 1,
        superseded_at: null,
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
    if (table === "tts_assets") {
      return {
        id: row.id ?? randomUUID(),
        byte_size: null,
        metadata: {},
        created_at: now,
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
      this.knownWords = this.knownWords.filter((entry) => !removedIds.has(entry.vocab_item_id));
      return;
    }
    if (table === "grammar_patterns") {
      // Mirror `on delete cascade` from grammar_exercises.grammar_pattern_id
      // so a clearLessonOwnedExtractionRows on retry also empties the
      // dependent exercises rather than leaving orphans pointing at deleted
      // pattern ids.
      const removedIds = new Set(removed.map((row) => row.id));
      this.grammarExercises = this.grammarExercises.filter(
        (ex) => !removedIds.has(ex.grammar_pattern_id),
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

function matchesIlike(value: string, pattern: string): boolean {
  const literal = pattern.replace(/\\([\\%_])/g, "$1");
  return value.toLocaleLowerCase() === literal.toLocaleLowerCase();
}

function byteLength(body: Buffer | Uint8Array | Blob | ArrayBuffer): number {
  if (body instanceof Buffer) return body.byteLength;
  if (body instanceof Uint8Array) return body.byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size;
  return 0;
}

class RowsQuery<TRow extends object> {
  private filters: Filter[] = [];
  private inFilters: Array<{ col: string; values: unknown[] }> = [];
  private ilikeFilters: Array<{ col: string; pattern: string }> = [];
  private isFilters: Array<{ col: string; value: null }> = [];
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
  is(col: string, value: null) {
    // PostgREST's `.is()` is strictly for null/true/false comparisons. The
    // fake only needs the null case today (extraction_runs.superseded_at).
    this.isFilters.push({ col, value });
    return this;
  }
  ilike(col: string, pattern: string) {
    this.ilikeFilters.push({ col, pattern });
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
    for (const f of this.ilikeFilters) {
      if (!matchesIlike(String(row[f.col] ?? ""), f.pattern)) return false;
    }
    for (const f of this.isFilters) {
      const value = row[f.col];
      if (f.value === null && value !== null && value !== undefined) return false;
    }
    return true;
  }

  private sortRows(rows: TRow[]): TRow[] {
    if (!this.ordering) return rows;
    const { col, ascending } = this.ordering;
    return [...rows].sort((a, b) => {
      const av = (a as AnyRow)[col];
      const bv = (b as AnyRow)[col];
      // Sort numerically when both sides are numbers (e.g. extraction_runs
      // ordered by version); fall back to lexicographic for timestamps and
      // segment_index strings.
      if (typeof av === "number" && typeof bv === "number") {
        return (ascending ? 1 : -1) * (av - bv);
      }
      return (ascending ? 1 : -1) * String(av).localeCompare(String(bv));
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
          // Preserve the conflict row's primary key on update. Without this
          // the fake's materializeRow would mint a fresh uuid and the
          // Object.assign below would clobber the existing id — breaking
          // any downstream FK (e.g. correction_drills →
          // teacher_corrections.id) that depended on the row's identity
          // surviving an upsert.
          const overwrite = {
            ...materialized,
            id: (conflict as AnyRow).id,
          };
          Object.assign(conflict, overwrite);
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
