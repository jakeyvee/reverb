-- Sentence-level English translation storage for the lesson transcript
-- (VOL-130). The Lesson Detail page renders the source-language transcript by
-- default; toggling translation surfaces the stored English rendering so the
-- household can review a lesson without replaying every minute of audio.
--
-- Translations are household-shared (mirrors transcript_segments itself) and
-- generated on demand from the Lesson Detail view: the first viewer pays the
-- model call, after that every household member reads the cached row. We do
-- not block the existing transcribing/diarizing/extracting stages on this — a
-- segment without a translation simply renders as "Translate" in the UI.
--
-- Per-word `gloss` data stays ephemeral for now (popover-only, generated from
-- the same Anthropic adapter) so we don't pre-bake every word the user might
-- click. If usage shows the same words being glossed repeatedly we can add a
-- second cache table later — keeping the schema small until then.

alter table public.transcript_segments
  add column if not exists translation text,
  add column if not exists translation_language text,
  add column if not exists translated_at timestamptz;

-- A short list of segment ids that the household toggled into translation
-- mode lives client-side. The translated text itself is what we persist.
comment on column public.transcript_segments.translation is
  'Cached English (or target-locale) translation of `text`, generated on demand from the Lesson Detail view.';
comment on column public.transcript_segments.translation_language is
  'BCP-47 tag for the language stored in `translation` (typically "en"). Null when no translation has been generated.';
comment on column public.transcript_segments.translated_at is
  'Wall-clock time at which the translation was generated. Surfaced for cache-bust diagnostics.';

-- Members already had select-only access via the transcripts_and_extractions
-- migration. Translation updates flow through the service role from the
-- /lessons server action so we keep transcript_segments insert/update locked
-- down to the service role — RLS posture is unchanged on purpose.
