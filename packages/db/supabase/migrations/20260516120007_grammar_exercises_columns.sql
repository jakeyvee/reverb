-- VOL-129 (2/2): Grammar exercise enhancements.
--
-- The MVP `grammar_exercises` table (20260514120005) supports a generic
-- prompt/answer/choices shape but lacks the affordances VOL-129 needs:
--
--   1. `accepted_answers` jsonb array — the grader accepts the canonical
--      `answer` plus any of these variants (case/whitespace-insensitive),
--      so an exercise can tolerate "saya mau kopi" vs "Saya mau kopi.".
--   2. `prompt_version` text — the generator prompt id stamped at write
--      time, mirroring extraction_runs.prompt_version. Lets a future
--      migration identify and regenerate exercises emitted by an older
--      prompt without dropping the user-facing rows the session selector
--      uses today.
--
-- The new `transform` enum value used by the generator is added in the
-- preceding migration so it can be safely referenced from default values
-- and code paths in subsequent commits. This migration only touches
-- columns, so it has no enum-visibility dependency.

alter table public.grammar_exercises
  add column if not exists accepted_answers jsonb not null default '[]'::jsonb;

alter table public.grammar_exercises
  add column if not exists prompt_version text;
