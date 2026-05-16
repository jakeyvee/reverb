import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Tables } from "@reverb/db/types";

// Hydrated dialogue-clip view used by the shadowing runner. The audio URL is
// a short-lived signed URL because `lesson-clips` is a private bucket.
//
// We surface caption + translation when the extractor wrote them so the
// runner has something to read while it plays. `durationMs` is best-effort:
// the extracting step writes start_ms/end_ms but the materialiser stores the
// probed duration under `metadata.materialization.audio_duration_ms`, which
// is the source of truth for the played-back clip.
export type ShadowingClipView = {
  clipId: string;
  lessonId: string;
  caption: string | null;
  translation: string | null;
  startMs: number;
  endMs: number;
  durationMs: number;
  audioUrl: string | null;
  lessonTitle: string | null;
};

export type LoadShadowingCandidatesOptions = {
  limit?: number;
};

// 1-8 second policy: matches the materialiser bounds from the lesson pipeline
// (VOL-126) so the runner never tries to play a clip that the issue says is
// out of range. Stored here so the orchestrator and shadowing module agree
// without importing from `apps/jobs`.
export const SHADOWING_CLIP_MIN_DURATION_MS = 1_000;
export const SHADOWING_CLIP_MAX_DURATION_MS = 8_000;

const SUPPORTED_AUDIO_BUCKETS = new Set(["lesson-clips"]);
// 90 minutes. The shadowing items are appended after the drill + vocab
// segments of the queue, so by the time the user actually mounts a shadowing
// card the URL may already be several minutes old. We sign once during
// `hydrateSession` and never refresh, so the TTL has to cover the worst-case
// "long session" path end-to-end — otherwise the `<audio>` element silently
// fails (the user would be asked to shadow something they can't hear) and
// there's no clear retry, since the recorder fallback assumes the clip
// already played. 90 minutes leaves comfortable headroom over the longest
// realistic daily-session length while keeping the credential short-lived.
const AUDIO_SIGNED_URL_TTL_SECONDS = 60 * 90;

const DEFAULT_LIMIT = 4;

type DialogueClipRow = Pick<
  Tables<"dialogue_clips">,
  | "id"
  | "lesson_id"
  | "start_ms"
  | "end_ms"
  | "storage_bucket"
  | "storage_path"
  | "caption"
  | "translation"
  | "metadata"
>;

// Reads the materialiser's success marker. A clip is shadowable only when:
//   * it has a non-null audio path AND
//   * `materialization.skip_reason` is null (i.e. the clip wasn't dropped
//     for being too short, too long, or out of range), AND
//   * the duration honours the 1-8s policy.
export function isShadowableClip(
  row: Pick<DialogueClipRow, "metadata" | "start_ms" | "end_ms">,
): boolean {
  const meta =
    row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : null;
  const materialization =
    meta?.materialization &&
    typeof meta.materialization === "object" &&
    !Array.isArray(meta.materialization)
      ? (meta.materialization as Record<string, unknown>)
      : null;
  if (!materialization) return false;
  if (materialization.skip_reason != null) return false;
  if (
    typeof materialization.audio_storage_path !== "string" ||
    materialization.audio_storage_path.length === 0
  ) {
    return false;
  }
  const duration =
    typeof materialization.audio_duration_ms === "number"
      ? materialization.audio_duration_ms
      : Math.max(0, row.end_ms - row.start_ms);
  return duration >= SHADOWING_CLIP_MIN_DURATION_MS && duration <= SHADOWING_CLIP_MAX_DURATION_MS;
}

function pickDurationMs(row: Pick<DialogueClipRow, "metadata" | "start_ms" | "end_ms">): number {
  const meta =
    row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : null;
  const materialization =
    meta?.materialization &&
    typeof meta.materialization === "object" &&
    !Array.isArray(meta.materialization)
      ? (meta.materialization as Record<string, unknown>)
      : null;
  if (materialization && typeof materialization.audio_duration_ms === "number") {
    return materialization.audio_duration_ms;
  }
  return Math.max(0, row.end_ms - row.start_ms);
}

// Returns the dialogue clips the user hasn't already passed (correct = true)
// in some prior session. The "already passed" filter keeps the same clip from
// reappearing tomorrow when the user has already self-marked it as got it —
// it's the closest thing we have to a per-clip "retired" state until we
// design a richer shadowing SRS.
export async function loadShadowingCandidates(
  supabase: SupabaseClient<Database>,
  userId: string,
  options: LoadShadowingCandidatesOptions = {},
): Promise<ShadowingClipView[]> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (limit <= 0) return [];

  // Pull more than we need so we can skip clips that are below/above the
  // duration policy or missing materialised audio before we hit the limit.
  const { data: rows, error } = await supabase
    .from("dialogue_clips")
    .select(
      "id, lesson_id, start_ms, end_ms, storage_bucket, storage_path, caption, translation, metadata",
    )
    .order("created_at", { ascending: false })
    .limit(limit * 4);
  if (error) {
    throw new Error(`Could not load dialogue_clips for shadowing: ${error.message}`);
  }
  const eligible = (rows ?? []).filter(isShadowableClip);
  if (eligible.length === 0) return [];

  // Suppress clips this user has already shadowed successfully. The
  // practice_session_items row carries (user_id, dialogue_clip_id, correct).
  const eligibleIds = eligible.map((row) => row.id);
  const { data: prior, error: priorError } = await supabase
    .from("practice_session_items")
    .select("dialogue_clip_id")
    .eq("user_id", userId)
    .eq("kind", "dialogue_clip")
    .eq("correct", true)
    .in("dialogue_clip_id", eligibleIds);
  if (priorError) {
    throw new Error(`Could not look up prior shadowing attempts: ${priorError.message}`);
  }
  const completed = new Set<string>();
  for (const row of prior ?? []) {
    if (row.dialogue_clip_id) completed.add(row.dialogue_clip_id);
  }

  const picked = eligible.filter((row) => !completed.has(row.id)).slice(0, limit);
  if (picked.length === 0) return [];

  const [audioByClipId, titleByLessonId] = await Promise.all([
    resolveAudioUrls(supabase, picked),
    resolveLessonTitles(
      supabase,
      picked.map((row) => row.lesson_id),
    ),
  ]);

  return picked.map((row) => ({
    clipId: row.id,
    lessonId: row.lesson_id,
    caption: row.caption,
    translation: row.translation,
    startMs: row.start_ms,
    endMs: row.end_ms,
    durationMs: pickDurationMs(row),
    audioUrl: audioByClipId.get(row.id) ?? null,
    lessonTitle: titleByLessonId.get(row.lesson_id) ?? null,
  }));
}

export async function loadShadowingClipsByIds(
  supabase: SupabaseClient<Database>,
  ids: string[],
): Promise<Map<string, ShadowingClipView>> {
  if (ids.length === 0) return new Map();
  const { data: rows, error } = await supabase
    .from("dialogue_clips")
    .select(
      "id, lesson_id, start_ms, end_ms, storage_bucket, storage_path, caption, translation, metadata",
    )
    .in("id", ids);
  if (error) {
    throw new Error(`Could not load dialogue_clips by id: ${error.message}`);
  }
  const usable = (rows ?? []).filter(isShadowableClip);
  if (usable.length === 0) return new Map();

  const [audioByClipId, titleByLessonId] = await Promise.all([
    resolveAudioUrls(supabase, usable),
    resolveLessonTitles(
      supabase,
      usable.map((row) => row.lesson_id),
    ),
  ]);

  const out = new Map<string, ShadowingClipView>();
  for (const row of usable) {
    out.set(row.id, {
      clipId: row.id,
      lessonId: row.lesson_id,
      caption: row.caption,
      translation: row.translation,
      startMs: row.start_ms,
      endMs: row.end_ms,
      durationMs: pickDurationMs(row),
      audioUrl: audioByClipId.get(row.id) ?? null,
      lessonTitle: titleByLessonId.get(row.lesson_id) ?? null,
    });
  }
  return out;
}

async function resolveAudioUrls(
  supabase: SupabaseClient<Database>,
  rows: ReadonlyArray<Pick<DialogueClipRow, "id" | "storage_bucket" | "storage_path">>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const results = await Promise.all(
    rows.map(async (row) => {
      if (!row.storage_bucket || !row.storage_path) return null;
      if (!SUPPORTED_AUDIO_BUCKETS.has(row.storage_bucket)) return null;
      const { data, error } = await supabase.storage
        .from(row.storage_bucket)
        .createSignedUrl(row.storage_path, AUDIO_SIGNED_URL_TTL_SECONDS);
      if (error || !data?.signedUrl) return null;
      return { clipId: row.id, url: data.signedUrl };
    }),
  );
  for (const result of results) {
    if (result) out.set(result.clipId, result.url);
  }
  return out;
}

async function resolveLessonTitles(
  supabase: SupabaseClient<Database>,
  lessonIds: ReadonlyArray<string | null>,
): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const id of lessonIds) {
    if (id) ids.add(id);
  }
  if (ids.size === 0) return new Map();
  const { data, error } = await supabase
    .from("lessons")
    .select("id, title")
    .in("id", Array.from(ids));
  if (error || !data) return new Map();
  return new Map(data.map((row) => [row.id, row.title] as const));
}

// XP awarded when the user self-marks "got it" on a shadowing clip. Sits one
// step above vocab `good` so a shadowing pass feels like meaningful progress
// alongside a vocab review session.
export const SHADOWING_XP_PER_PASS = 4;
