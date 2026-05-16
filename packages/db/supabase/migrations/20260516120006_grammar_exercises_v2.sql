-- VOL-129 (1/2): Teach `grammar_exercise_kind` about the transform-this-
-- sentence exercise type.
--
-- Postgres requires `alter type ... add value` to commit before the new
-- value can be referenced inside a check constraint, default, or function
-- body, so the matching column work lives in the next migration. Splitting
-- the file is the only way to make the migration runnable inside
-- Supabase's per-file transaction (see the matching pattern in VOL-121's
-- 20260516120004 / 20260516120005 pair).

alter type public.grammar_exercise_kind add value if not exists 'transform';
