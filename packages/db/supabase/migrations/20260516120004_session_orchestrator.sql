-- VOL-121 (1/2): Teach `practice_item_kind` about mistake drills.
--
-- This is the enum-extension half of the daily-session orchestrator change.
-- Postgres requires `alter type ... add value` to commit before the new
-- value can be referenced inside a check constraint or function body, so
-- the matching column + constraint + trigger work lives in the next
-- migration. Splitting the file is the only way to make the migration
-- runnable inside Supabase's per-file transaction.

alter type public.practice_item_kind add value if not exists 'mistake_drill';
