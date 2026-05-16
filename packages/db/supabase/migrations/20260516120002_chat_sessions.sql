-- AI Bahasa conversation partner (VOL-131).
--
-- Free-form chat sits alongside the SRS queue: the user practises producing
-- Indonesian in conversation while the model corrects mistakes inline. The
-- whole feature is per-user (a partner should never see the other's chat
-- history, mistakes, or the AI's running summary of their level), so every
-- table here scopes through `user_id = auth.uid()` rather than the household.
--
-- Tables:
--   chat_sessions     — one row per started conversation. We append messages
--                       to the most recent active row for that user; a fresh
--                       "Start over" click marks the current row ended and
--                       inserts a new active row. `summary` lets us compress
--                       long sessions instead of feeding the whole transcript
--                       back into the prompt each turn (token bound).
--   chat_messages     — append-only transcript. `role` mirrors Anthropic's
--                       message roles. Assistant turns also carry the JSON
--                       response in `metadata` for replay / debugging.
--   chat_corrections  — one row per teacher-style correction the model
--                       emitted against a *user* message. Kept separate from
--                       the transcript so a future job can graph error rate,
--                       drive XP, or seed correction drills without
--                       re-parsing assistant payloads.

create type public.chat_message_role as enum (
  'user',
  'assistant'
);

create type public.chat_correction_kind as enum (
  'grammar',
  'vocabulary',
  'pronunciation',
  'usage'
);

create table public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Snapshot of the user's self-reported level when the session began. The
  -- prompt builder reads this to size grammar / vocab expectations.
  level text not null default 'beginner',
  status text not null default 'active',
  summary text,
  -- Counters maintained by the web action so the prompt builder can pick a
  -- bounded history window without a fresh count(*) on every turn.
  total_messages integer not null default 0,
  total_user_messages integer not null default 0,
  last_message_at timestamptz,
  ended_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index chat_sessions_user_last_idx
  on public.chat_sessions (user_id, last_message_at desc nulls last);
create index chat_sessions_user_status_idx
  on public.chat_sessions (user_id, status);

create trigger chat_sessions_set_updated_at
  before update on public.chat_sessions
  for each row execute function public.set_updated_at();

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.chat_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.chat_message_role not null,
  content text not null,
  -- BCP47-ish: 'id' for Indonesian, 'en' for English fallbacks. The model is
  -- instructed to stay in Indonesian — this column lets us flag fallbacks for
  -- analytics without re-running language detection.
  language text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index chat_messages_session_created_idx
  on public.chat_messages (session_id, created_at);
create index chat_messages_user_created_idx
  on public.chat_messages (user_id, created_at desc);

create table public.chat_corrections (
  id uuid primary key default gen_random_uuid(),
  -- Points at the user message the correction is *about*. A single user
  -- message may produce several corrections (e.g. a grammar miss and a vocab
  -- miss in the same sentence).
  message_id uuid not null references public.chat_messages(id) on delete cascade,
  session_id uuid not null references public.chat_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind public.chat_correction_kind not null default 'grammar',
  source_text text not null,
  corrected_text text not null,
  explanation text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index chat_corrections_session_idx
  on public.chat_corrections (session_id, created_at);
create index chat_corrections_user_created_idx
  on public.chat_corrections (user_id, created_at desc);

alter table public.chat_sessions enable row level security;
alter table public.chat_messages enable row level security;
alter table public.chat_corrections enable row level security;

-- Per-user CRUD: the caller can only ever see or write rows they own. There
-- is no household-shared view of chat — pairing this with the vocab tables
-- (which *are* shared) is deliberate, because the prompt mixes a user's
-- personal mistake history into the conversation context.
create policy "chat_sessions_select_self" on public.chat_sessions
  for select to authenticated using (user_id = auth.uid());
create policy "chat_sessions_insert_self" on public.chat_sessions
  for insert to authenticated with check (user_id = auth.uid());
create policy "chat_sessions_update_self" on public.chat_sessions
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
create policy "chat_sessions_delete_self" on public.chat_sessions
  for delete to authenticated using (user_id = auth.uid());

-- Messages have to land under one of the caller's own sessions. Without the
-- EXISTS check a client that learned another user's session id could
-- ghost-write into that transcript by tagging the insert with its own
-- user_id.
create policy "chat_messages_select_self" on public.chat_messages
  for select to authenticated using (user_id = auth.uid());
create policy "chat_messages_insert_self" on public.chat_messages
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.chat_sessions s
      where s.id = chat_messages.session_id
        and s.user_id = auth.uid()
    )
  );

create policy "chat_corrections_select_self" on public.chat_corrections
  for select to authenticated using (user_id = auth.uid());
create policy "chat_corrections_insert_self" on public.chat_corrections
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.chat_messages m
      where m.id = chat_corrections.message_id
        and m.user_id = auth.uid()
    )
  );

-- Atomic counter bump for a finished round-trip. The web action would
-- otherwise have to read total_messages, add 2, and write the sum back —
-- which races against a concurrent second tab / double-submit and loses
-- increments. Doing it inside the database removes the read-modify-write
-- window. RLS still gates this: the function runs as the caller, and the
-- WHERE clause requires the row's user_id to match auth.uid(), so a client
-- can't bump another user's counters even if they learned the session id.
-- p_user_message_increment is 1 for a normal turn and 0 for assistant-only
-- bumps if we ever introduce them; defaulting it keeps the call site terse.
create or replace function public.bump_chat_session_counters(
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
  update public.chat_sessions
     set total_messages = total_messages + p_message_increment,
         total_user_messages = total_user_messages + p_user_message_increment,
         last_message_at = now()
   where id = p_session_id
     and user_id = auth.uid();
end;
$$;

revoke all on function public.bump_chat_session_counters(uuid, integer, integer) from public;
grant execute on function public.bump_chat_session_counters(uuid, integer, integer)
  to authenticated, service_role;
