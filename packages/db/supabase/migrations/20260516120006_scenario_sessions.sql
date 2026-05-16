-- Travel role-play scenarios (VOL-133).
--
-- Fixed PRD scenarios that drop the learner into a constrained Bahasa role-
-- play (ordering food, taxi, hotel, market, directions, pharmacy, beach
-- rental, ojek/Grab). Each scenario practice has its own row so we can show
-- "you've done the hotel scene 3 times" later, and so concurrent scenes
-- under one user don't collide on a single active row.
--
-- The shape mirrors `chat_sessions` / `chat_messages` / `chat_corrections`:
-- the role-play uses the same Anthropic-driven structured payload (reply +
-- corrections), so reusing the chat enums means the AI adapter can write
-- both flows through the same shape without a second correction-kind enum.
-- The two flows diverge only in:
--   - scenario_sessions pins a `scenario_id` so the prompt can be looked up.
--   - scenario_sessions tracks completion + xp_earned so the orchestrator
--     can hand 10 XP and write a `practice_events` row on the same finish.
--
-- Tables:
--   scenario_sessions   — one row per started scenario. `status` walks
--                         active → completed | abandoned, and `xp_earned`
--                         records how much XP was awarded on completion.
--   scenario_messages   — append-only transcript. Mirrors chat_messages.
--   scenario_corrections — per-correction audit, one row per critique the
--                         model emitted against a *user* message.

create table public.scenario_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Stable scenario identifier from @reverb/domain SCENARIO_IDS. Stored as
  -- text rather than an enum so adding a 9th PRD scenario later doesn't
  -- need a two-step `alter type / use type` migration. The web layer
  -- validates incoming ids against the Zod enum before insert, so the
  -- column never carries an unknown value at runtime.
  scenario_id text not null,
  -- Snapshot of the learner's chat level at start. Drives prompt sizing.
  level text not null default 'beginner',
  status text not null default 'active',
  xp_earned integer not null default 0,
  total_messages integer not null default 0,
  total_user_messages integer not null default 0,
  last_message_at timestamptz,
  completed_at timestamptz,
  abandoned_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scenario_sessions_status_check check (
    status in ('active', 'completed', 'abandoned')
  )
);

create index scenario_sessions_user_status_idx
  on public.scenario_sessions (user_id, status);
create index scenario_sessions_user_started_idx
  on public.scenario_sessions (user_id, created_at desc);

create trigger scenario_sessions_set_updated_at
  before update on public.scenario_sessions
  for each row execute function public.set_updated_at();

create table public.scenario_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.scenario_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.chat_message_role not null,
  content text not null,
  language text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index scenario_messages_session_created_idx
  on public.scenario_messages (session_id, created_at);
create index scenario_messages_user_created_idx
  on public.scenario_messages (user_id, created_at desc);

create table public.scenario_corrections (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.scenario_messages(id) on delete cascade,
  session_id uuid not null references public.scenario_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind public.chat_correction_kind not null default 'grammar',
  source_text text not null,
  corrected_text text not null,
  explanation text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index scenario_corrections_session_idx
  on public.scenario_corrections (session_id, created_at);
create index scenario_corrections_user_created_idx
  on public.scenario_corrections (user_id, created_at desc);

alter table public.scenario_sessions enable row level security;
alter table public.scenario_messages enable row level security;
alter table public.scenario_corrections enable row level security;

-- Per-user CRUD. Scenarios are always personal (a partner shouldn't see
-- the other's role-play history), so RLS scopes everything by auth.uid().

create policy "scenario_sessions_select_self" on public.scenario_sessions
  for select to authenticated using (user_id = auth.uid());
create policy "scenario_sessions_insert_self" on public.scenario_sessions
  for insert to authenticated with check (user_id = auth.uid());
create policy "scenario_sessions_update_self" on public.scenario_sessions
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
create policy "scenario_sessions_delete_self" on public.scenario_sessions
  for delete to authenticated using (user_id = auth.uid());

-- Messages must land under one of the caller's own sessions, otherwise a
-- client that learned another user's session id could append into that
-- transcript by tagging the insert with its own user_id.
create policy "scenario_messages_select_self" on public.scenario_messages
  for select to authenticated using (user_id = auth.uid());
create policy "scenario_messages_insert_self" on public.scenario_messages
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.scenario_sessions s
      where s.id = scenario_messages.session_id
        and s.user_id = auth.uid()
    )
  );

create policy "scenario_corrections_select_self" on public.scenario_corrections
  for select to authenticated using (user_id = auth.uid());
create policy "scenario_corrections_insert_self" on public.scenario_corrections
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.scenario_messages m
      where m.id = scenario_corrections.message_id
        and m.user_id = auth.uid()
    )
  );

-- Atomic counter bump for a finished round-trip. Same pattern as
-- bump_chat_session_counters: the web action would otherwise have to read
-- total_messages, add two, and write it back, which loses increments under
-- concurrent tab / double-submit. The RLS WHERE clause keeps a client from
-- bumping another user's row even if they learned the session id.
create or replace function public.bump_scenario_session_counters(
  p_session_id uuid,
  p_message_increment integer default 2,
  p_user_message_increment integer default 1
)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  update public.scenario_sessions
     set total_messages = total_messages + p_message_increment,
         total_user_messages = total_user_messages + p_user_message_increment,
         last_message_at = now()
   where id = p_session_id
     and user_id = auth.uid();
end;
$$;

revoke all on function public.bump_scenario_session_counters(uuid, integer, integer) from public;
grant execute on function public.bump_scenario_session_counters(uuid, integer, integer)
  to authenticated, service_role;
