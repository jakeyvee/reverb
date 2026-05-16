-- VOL-136: Overrides, flags, and lesson reprocessing.
--
-- The MVP's LLM extraction quality will not be perfect. Three lightweight
-- controls cover the most common gaps without rebuilding the pipeline:
--
--   1. "I already know this" overrides:
--      Already supported via `user_known_words` — this migration only adds an
--      index for the action's "delete the user's card for that vocab" path so
--      the row removal scales with practice volume rather than household size.
--
--   2. Flag bad extraction:
--      `extraction_flags` is the per-household audit log of "this item was
--      wrong". Each row points at a specific extracted item (vocab, grammar,
--      dialogue, correction) and carries the user-provided reason plus the
--      extraction context (`extraction_run_id`, model, prompt_version) so a
--      future prompt eval pass can replay the failure without re-deriving it.
--      Flags are advisory — they do not hide the item, so the partner's deck
--      stays intact even if one user flags the same word.
--
--   3. Re-run extraction:
--      `extraction_runs.version` lets multiple extraction attempts coexist for
--      the same lesson — required so the UI can render "this lesson has been
--      reprocessed N times" and so a future analytics pass can diff prompt
--      versions side-by-side. `superseded_at` marks runs that no longer match
--      the lesson's derived data (vocab/corrections/grammar/dialogue), so a
--      single index range over the current version is what the UI reads.
--
-- The matching delete-vs-upsert change in the extracting step preserves
-- per-user practice state where the underlying identity still applies:
--
--   - `vocab_items` are already deduped on (household_id, lower(lemma),
--     coalesce(reading, '')), so cards + FSRS history carry across runs by
--     virtue of the upsert that already lives in `steps.ts`.
--
--   - `teacher_corrections` previously rebuilt from scratch on every run,
--     which cascade-dropped `correction_drills` (per-user FSRS-like state).
--     The new unique index gives the upsert a stable natural key so identical
--     corrections — same lesson, kind, source/corrected text — reuse the
--     existing row and the user's mistake-drill progress survives a reprocess.

-- Index lookups by user_id are already present; the (vocab_item_id, user_id)
-- composite speeds up the action's "remove this user's card for this vocab"
-- path (delete from cards where user_id = ? and vocab_item_id = ?). Without
-- it the cards table is scanned per-mark, which is fine today and miserable
-- once both users have a few hundred reviews each.
create index if not exists cards_user_vocab_idx
  on public.cards (user_id, vocab_item_id);

-- Stable natural key for teacher_corrections. The extracting step already
-- dedupes its in-memory candidates on (lesson_id, kind, source_text,
-- corrected_text); promoting that to a unique index lets the worker switch
-- from "delete all rows for this lesson and re-insert" to an upsert that
-- preserves the row id — and with it the correction_drills FK that hangs
-- off it.
create unique index if not exists teacher_corrections_lesson_identity_uniq
  on public.teacher_corrections (lesson_id, kind, source_text, corrected_text);

-- Reprocessing creates a new run row per kind without dropping the old one;
-- `version` orders runs within a (lesson, kind), `superseded_at` flags the
-- ones whose output no longer matches the live tables. Defaults keep older
-- in-tree rows compatible: existing data is read as version 1, current.
alter table public.extraction_runs
  add column if not exists version integer not null default 1,
  add column if not exists superseded_at timestamptz;

create index if not exists extraction_runs_lesson_kind_version_idx
  on public.extraction_runs (lesson_id, kind, version desc);

-- One flag row per (user, item) is enough — multiple flags from the same
-- user on the same item are coalesced. Different users can each flag the
-- same item; we keep their notes and reasons separately so a prompt review
-- pass can see how many distinct people thought the item was wrong.
create type public.extraction_flag_target_kind as enum (
  'vocab',
  'grammar',
  'dialogue',
  'correction'
);

create type public.extraction_flag_reason as enum (
  'wrong_translation',
  'not_a_word',
  'wrong_split',
  'duplicate',
  'low_value',
  'other'
);

create table public.extraction_flags (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  lesson_id uuid not null references public.lessons(id) on delete cascade,
  target_kind public.extraction_flag_target_kind not null,
  -- Polymorphic FK: target_id points at one of the four extracted-item tables
  -- depending on target_kind. We don't enforce the FK at the database level
  -- because Postgres can't model conditional FKs cleanly; the server action
  -- is the single writer and checks the target exists before inserting. The
  -- containing lesson + household_id keep RLS scoping unambiguous either way.
  target_id uuid not null,
  reason public.extraction_flag_reason not null,
  notes text,
  flagged_by uuid not null references auth.users(id) on delete cascade,
  -- Snapshot the extraction context so a flag remains interpretable even if
  -- the underlying item is rewritten or removed by a later reprocess. The
  -- run id is the canonical pointer; model + prompt_version are duplicated
  -- here to keep a fast "group flags by prompt_version" query off the
  -- extraction_runs table.
  extraction_run_id uuid references public.extraction_runs(id) on delete set null,
  model text,
  prompt_version text,
  created_at timestamptz not null default now(),
  unique (target_kind, target_id, flagged_by)
);

create index extraction_flags_household_id_idx on public.extraction_flags (household_id);
create index extraction_flags_lesson_id_idx on public.extraction_flags (lesson_id);
create index extraction_flags_target_idx on public.extraction_flags (target_kind, target_id);
create index extraction_flags_prompt_version_idx
  on public.extraction_flags (prompt_version)
  where prompt_version is not null;

alter table public.extraction_flags enable row level security;

-- Members of a household see flags for their own household. Flags are an
-- internal feedback mechanism; we do not expose another household's flag log
-- even though the underlying lessons are already household-scoped.
create policy "extraction_flags_select_household" on public.extraction_flags
  for select to authenticated
  using (household_id = public.current_household_id());

-- Insert is scoped on both axes: the caller is the flagger, and the flag must
-- land on a lesson the caller's household owns. The (target_kind, target_id,
-- flagged_by) unique index coalesces double-clicks into a single row.
create policy "extraction_flags_insert_self" on public.extraction_flags
  for insert to authenticated
  with check (
    flagged_by = auth.uid()
    and household_id = public.current_household_id()
    and exists (
      select 1 from public.lessons l
      where l.id = extraction_flags.lesson_id
        and l.household_id = public.current_household_id()
    )
  );

-- A flag can be removed by its author (the UI's "undo flag" affordance). Other
-- members of the household cannot delete someone else's flag — that would
-- make the audit log untrustworthy without giving them anything they can't
-- already do by flagging the item themselves.
create policy "extraction_flags_delete_self" on public.extraction_flags
  for delete to authenticated
  using (flagged_by = auth.uid());
