-- VOL-121 (2/2): Daily session orchestrator + resume.
--
-- The MVP daily session mixes due FSRS vocab cards with priority mistake
-- drills. `practice_sessions` and `practice_session_items` already model
-- the one-row-per-session-shape; this migration teaches them about
-- correction drills and the daily-session lifecycle. The enum value used
-- below (`mistake_drill`) is added by the preceding migration so that this
-- file can reference it inside the rebuilt check constraint.
--
-- Changes:
--
--   1. `practice_session_items.correction_drill_id` is the per-item FK for
--      mistake drills, matching the existing FK columns for the other
--      kinds. `on delete set null` keeps the audit row alive when the
--      referenced drill is retired or pruned (mirrors the existing FKs).
--
--   2. The exclusive-target check is rebuilt to enforce "exactly one FK
--      per kind", and the insert trigger learns the new kind so a missing
--      target id is rejected at write time.
--
--   3. `practice_sessions_user_active_day_uniq` enforces "one active
--      session per user per UTC day". The orchestrator already guards this
--      with find-then-insert in code, but the partial unique index makes
--      the invariant hold under concurrent tab loads (refresh races).
--      Completed/abandoned sessions earlier in the day do not block a new
--      session because the index is partial over `status = 'active'`.

alter table public.practice_session_items
  add column if not exists correction_drill_id uuid
    references public.correction_drills(id) on delete set null;

create index if not exists practice_session_items_correction_drill_id_idx
  on public.practice_session_items (correction_drill_id);

alter table public.practice_session_items
  drop constraint if exists practice_session_items_target_exclusive_check;

alter table public.practice_session_items
  add constraint practice_session_items_target_exclusive_check check (
    (kind = 'card'
       and grammar_exercise_id is null
       and dialogue_clip_id is null
       and correction_drill_id is null)
    or (kind = 'grammar_exercise'
       and card_id is null
       and dialogue_clip_id is null
       and correction_drill_id is null)
    or (kind = 'dialogue_clip'
       and card_id is null
       and grammar_exercise_id is null
       and correction_drill_id is null)
    or (kind = 'mistake_drill'
       and card_id is null
       and grammar_exercise_id is null
       and dialogue_clip_id is null)
  );

create or replace function public.enforce_practice_session_item_target()
returns trigger
language plpgsql
as $$
begin
  if (new.kind = 'card' and new.card_id is null)
     or (new.kind = 'grammar_exercise' and new.grammar_exercise_id is null)
     or (new.kind = 'dialogue_clip' and new.dialogue_clip_id is null)
     or (new.kind = 'mistake_drill' and new.correction_drill_id is null) then
    raise exception 'practice_session_items.% requires a non-null target id', new.kind
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create unique index if not exists practice_sessions_user_active_day_uniq
  on public.practice_sessions (user_id, (started_at::date))
  where status = 'active';
