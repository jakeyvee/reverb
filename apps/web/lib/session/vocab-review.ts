import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@reverb/db/types";
import { loadDueVocabCards, type DueVocabCard } from "@/lib/vocab/reviews";

// Buckets that store vocab review audio. Both TTS-cached headwords and
// dialogue clips live in private buckets, so the review UI receives a
// short-lived signed URL rather than a public link.
const SUPPORTED_AUDIO_BUCKETS = new Set(["tts-cache", "lesson-clips"]);

// 10 minutes — long enough for a paged review session, short enough to keep
// the credential out of long-lived browser caches. Mirrors the lesson detail
// player TTL in apps/web/lib/lessons/transcript.ts.
const AUDIO_SIGNED_URL_TTL_SECONDS = 60 * 10;

export type ReviewableVocabCard = DueVocabCard & {
  audioUrl: string | null;
  lessonTitle: string | null;
};

export type LoadDueVocabReviewOptions = {
  now?: Date;
  limit?: number;
};

// Loads the user's due vocab cards and enriches each one with a signed audio
// URL (when the vocab item has cached TTS audio) and the source lesson
// title (when the vocab was extracted from a lesson). Missing audio or
// lesson info is non-fatal — the UI degrades gracefully to text only.
export async function loadDueVocabReviewCards(
  supabase: SupabaseClient<Database>,
  userId: string,
  options: LoadDueVocabReviewOptions = {},
): Promise<ReviewableVocabCard[]> {
  const cards = await loadDueVocabCards(supabase, userId, options);
  if (cards.length === 0) return [];

  const [audioUrlByCardId, lessonTitleById] = await Promise.all([
    resolveAudioUrls(supabase, cards),
    resolveLessonTitles(supabase, cards),
  ]);

  return cards.map((card) => ({
    ...card,
    audioUrl: audioUrlByCardId.get(card.cardId) ?? null,
    lessonTitle: card.vocab.lessonId ? lessonTitleById.get(card.vocab.lessonId) ?? null : null,
  }));
}

async function resolveAudioUrls(
  supabase: SupabaseClient<Database>,
  cards: DueVocabCard[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  // Sign one URL per card. The bucket is private so we can't reuse a single
  // pre-signed prefix — Supabase Storage signs each object path individually.
  // Run the requests in parallel so a 20-card page still resolves in a single
  // round-trip's worth of latency.
  const results = await Promise.all(
    cards.map(async (card) => {
      const bucket = card.vocab.audioStorageBucket;
      const path = card.vocab.audioStoragePath;
      if (!bucket || !path) return null;
      if (!SUPPORTED_AUDIO_BUCKETS.has(bucket)) return null;
      const { data, error } = await supabase.storage
        .from(bucket)
        .createSignedUrl(path, AUDIO_SIGNED_URL_TTL_SECONDS);
      if (error || !data?.signedUrl) return null;
      return { cardId: card.cardId, url: data.signedUrl };
    }),
  );
  for (const result of results) {
    if (result) out.set(result.cardId, result.url);
  }
  return out;
}

async function resolveLessonTitles(
  supabase: SupabaseClient<Database>,
  cards: DueVocabCard[],
): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const card of cards) {
    if (card.vocab.lessonId) ids.add(card.vocab.lessonId);
  }
  if (ids.size === 0) return new Map();
  const { data, error } = await supabase
    .from("lessons")
    .select("id, title")
    .in("id", Array.from(ids));
  if (error || !data) return new Map();
  return new Map(data.map((row) => [row.id, row.title] as const));
}
