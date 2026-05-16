// VOL-124: Demo lessons are seeded into the database by `supabase db reset`
// so a fresh install can run the MVP daily session before any real upload.
// They are tagged on `lessons.metadata.demo = true` (see
// packages/db/supabase/seed.sql). The marker has two jobs:
//
//   1. UI hint — the lesson detail page can render a "Demo" badge so the
//      seeded fixture isn't mistaken for real recorded content.
//   2. Processing guard — the worker pipeline never picks up demo lessons.
//      The upload action only ever inserts fresh UUIDs (never the seeded
//      ones), but the retry / reprocess actions look up lessons by id, so
//      we short-circuit those server actions when the lesson is demo.
//      Combined with the fact that nothing dispatches Trigger.dev for these
//      ids, the demo fixture stays inert end-to-end.
//
// Accepts the loose `Json` shape supabase-js returns for `jsonb` columns so
// callers can pass `lessons.metadata` straight through without narrowing.
export function isDemoLessonMetadata(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  return (metadata as { demo?: unknown }).demo === true;
}
