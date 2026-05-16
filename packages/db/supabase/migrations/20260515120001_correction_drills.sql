-- Teacher-correction mistake drills (VOL-120).
--
-- `teacher_corrections` are household-shared (one row per correction extracted
-- from the lesson). The per-user practice state lives in `correction_drills`,
-- one row per (user, teacher_correction). That split mirrors the vocab pattern
-- (`vocab_items` shared, `cards` per-user) so a partner's progress on the same
-- correction never affects the other user's queue.
--
-- The extracting step (VOL-115) emits a `confidence` value alongside each
-- correction. The column is added here as nullable + bounded so old rows from
-- before VOL-120 land as NULL and the session selection can treat NULL as
-- "unscored, surface as normal". Sub-threshold confidence corrections are
-- labeled (rather than dropped) so the user can still see what the model
-- flagged — the session loader is the single place that decides whether a
-- given drill is eligible to be scheduled.
--
-- Drill state machine, driven entirely from `record_correction_drill_attempt`
-- (no Postgres trigger needed — the web action is the only writer):
--   new       -> drill has never been attempted; due immediately.
--   learning  -> at least one attempt; due_at moves on each result.
--   retired   -> user passed enough times that we stop scheduling it. The
--                row sticks around for history but is filtered out of
--                session selection.
--
-- Attempts are logged in a separate audit table so a future analytics pass
-- can graph per-correction error rates without re-reading the rolled-up
-- counters on `correction_drills`.

alter table public.teacher_corrections
  add column if not exists confidence real,
  add constraint teacher_corrections_confidence_check
    check (confidence is null or (confidence >= 0 and confidence <= 1));

create type public.correction_drill_state as enum (
  'new',
  'learning',
  'retired'
);

create type public.correction_drill_result as enum (
  'pass',
  'fail'
);

create table public.correction_drills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  teacher_correction_id uuid not null references public.teacher_corrections(id) on delete cascade,
  state public.correction_drill_state not null default 'new',
  due_at timestamptz not null default now(),
  attempts integer not null default 0,
  passes integer not null default 0,
  fails integer not null default 0,
  consecutive_passes integer not null default 0,
  last_result public.correction_drill_result,
  last_attempted_at timestamptz,
  retired_at timestamptz,
  xp_earned integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, teacher_correction_id)
);

create index correction_drills_user_due_idx
  on public.correction_drills (user_id, due_at)
  where state <> 'retired';
create index correction_drills_user_state_idx
  on public.correction_drills (user_id, state);
create index correction_drills_teacher_correction_idx
  on public.correction_drills (teacher_correction_id);

create trigger correction_drills_set_updated_at
  before update on public.correction_drills
  for each row execute function public.set_updated_at();

create table public.correction_drill_attempts (
  id uuid primary key default gen_random_uuid(),
  drill_id uuid not null references public.correction_drills(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  result public.correction_drill_result not null,
  response_ms integer,
  xp_awarded integer not null default 0,
  -- Stores the user's typed answer when the attempt was a retype, so a future
  -- analytics pass can see what shape of mistake recurs without re-reading the
  -- original correction text. Empty for self-mark attempts.
  user_response text,
  attempted_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index correction_drill_attempts_drill_id_idx
  on public.correction_drill_attempts (drill_id);
create index correction_drill_attempts_user_attempted_idx
  on public.correction_drill_attempts (user_id, attempted_at desc);

alter table public.correction_drills enable row level security;
alter table public.correction_drill_attempts enable row level security;

-- Per-user CRUD. Inserts must point at a correction the caller's household
-- owns, otherwise a client that learned another household's correction id
-- could spawn a drill row keyed under its own user_id and surface that text
-- in their session.
create policy "correction_drills_select_self" on public.correction_drills
  for select to authenticated using (user_id = auth.uid());

create policy "correction_drills_insert_self" on public.correction_drills
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.teacher_corrections tc
      where tc.id = correction_drills.teacher_correction_id
        and tc.household_id = public.current_household_id()
    )
  );

create policy "correction_drills_update_self" on public.correction_drills
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "correction_drills_delete_self" on public.correction_drills
  for delete to authenticated using (user_id = auth.uid());

-- Same structure for attempt logs: insert must target one of the caller's
-- own drill rows. The select policy is plain self-scope.
create policy "correction_drill_attempts_select_self" on public.correction_drill_attempts
  for select to authenticated using (user_id = auth.uid());

create policy "correction_drill_attempts_insert_self" on public.correction_drill_attempts
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.correction_drills d
      where d.id = correction_drill_attempts.drill_id
        and d.user_id = auth.uid()
    )
  );
