-- Per-user practice + engagement layer: sessions, the items in those sessions,
-- the event stream the UI emits, daily streaks, and scheduled notifications.
-- Everything in this migration is strictly scoped by auth.uid().

create type public.practice_session_status as enum (
  'active',
  'completed',
  'abandoned'
);

create type public.practice_item_kind as enum (
  'card',
  'grammar_exercise',
  'dialogue_clip'
);

create type public.practice_event_kind as enum (
  'session_start',
  'session_complete',
  'session_abandon',
  'item_shown',
  'item_answered',
  'item_skipped',
  'pause',
  'resume'
);

create type public.notification_event_kind as enum (
  'streak_reminder',
  'session_due',
  'lesson_ready',
  'milestone'
);

create type public.notification_channel as enum ('push', 'email');

create type public.notification_status as enum (
  'queued',
  'sent',
  'failed',
  'cancelled'
);

create table public.practice_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  lesson_id uuid references public.lessons(id) on delete set null,
  status public.practice_session_status not null default 'active',
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  duration_ms integer,
  xp_earned integer not null default 0,
  cards_reviewed integer not null default 0,
  exercises_attempted integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index practice_sessions_user_started_idx
  on public.practice_sessions(user_id, started_at desc);
create index practice_sessions_lesson_id_idx on public.practice_sessions(lesson_id);

create trigger practice_sessions_set_updated_at
  before update on public.practice_sessions
  for each row execute function public.set_updated_at();

-- One row per item served inside a session. The row-level invariant only
-- enforces mutual exclusion across the three target FKs: the matching id may
-- end up null after `on delete set null` fires, but the other two must stay
-- null so `kind` is always unambiguous. Presence of the target at INSERT time
-- is enforced by `enforce_practice_session_item_target` below.
create table public.practice_session_items (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.practice_sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  position integer not null,
  kind public.practice_item_kind not null,
  card_id uuid references public.cards(id) on delete set null,
  grammar_exercise_id uuid references public.grammar_exercises(id) on delete set null,
  dialogue_clip_id uuid references public.dialogue_clips(id) on delete set null,
  shown_at timestamptz,
  answered_at timestamptz,
  rating public.review_rating,
  correct boolean,
  response_ms integer,
  metadata jsonb not null default '{}'::jsonb,
  unique (session_id, position),
  constraint practice_session_items_target_exclusive_check check (
    (kind = 'card' and grammar_exercise_id is null and dialogue_clip_id is null)
    or (kind = 'grammar_exercise' and card_id is null and dialogue_clip_id is null)
    or (kind = 'dialogue_clip' and card_id is null and grammar_exercise_id is null)
  )
);

create index practice_session_items_session_id_idx on public.practice_session_items(session_id);
create index practice_session_items_user_id_idx on public.practice_session_items(user_id);

create or replace function public.enforce_practice_session_item_target()
returns trigger
language plpgsql
as $$
begin
  if (new.kind = 'card' and new.card_id is null)
     or (new.kind = 'grammar_exercise' and new.grammar_exercise_id is null)
     or (new.kind = 'dialogue_clip' and new.dialogue_clip_id is null) then
    raise exception 'practice_session_items.% requires a non-null target id', new.kind
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger practice_session_items_target_required
  before insert on public.practice_session_items
  for each row execute function public.enforce_practice_session_item_target();

create table public.practice_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid references public.practice_sessions(id) on delete set null,
  session_item_id uuid references public.practice_session_items(id) on delete set null,
  kind public.practice_event_kind not null,
  occurred_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb
);

create index practice_events_user_occurred_idx
  on public.practice_events(user_id, occurred_at desc);
create index practice_events_session_id_idx on public.practice_events(session_id);

create table public.streaks (
  user_id uuid primary key references auth.users(id) on delete cascade,
  current_length integer not null default 0,
  longest_length integer not null default 0,
  last_practiced_on date,
  timezone text not null default 'UTC',
  updated_at timestamptz not null default now()
);

create trigger streaks_set_updated_at
  before update on public.streaks
  for each row execute function public.set_updated_at();

create table public.notification_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind public.notification_event_kind not null,
  channel public.notification_channel not null,
  status public.notification_status not null default 'queued',
  scheduled_for timestamptz,
  sent_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index notification_events_user_id_idx on public.notification_events(user_id);
create index notification_events_due_idx
  on public.notification_events(scheduled_for)
  where status = 'queued';

create trigger notification_events_set_updated_at
  before update on public.notification_events
  for each row execute function public.set_updated_at();

alter table public.practice_sessions enable row level security;
alter table public.practice_session_items enable row level security;
alter table public.practice_events enable row level security;
alter table public.streaks enable row level security;
alter table public.notification_events enable row level security;

create policy "practice_sessions_select_self" on public.practice_sessions
  for select to authenticated using (user_id = auth.uid());
create policy "practice_sessions_insert_self" on public.practice_sessions
  for insert to authenticated with check (user_id = auth.uid());
create policy "practice_sessions_update_self" on public.practice_sessions
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
create policy "practice_sessions_delete_self" on public.practice_sessions
  for delete to authenticated using (user_id = auth.uid());

create policy "practice_session_items_select_self" on public.practice_session_items
  for select to authenticated using (user_id = auth.uid());

-- Insert / update must land in a session the caller owns. The user_id column
-- alone isn't enough: a client could otherwise attach items to another user's
-- session, and the unique (session_id, position) constraint would then block
-- the real owner from claiming that position.
create policy "practice_session_items_insert_self" on public.practice_session_items
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.practice_sessions s
      where s.id = practice_session_items.session_id
        and s.user_id = auth.uid()
    )
  );

create policy "practice_session_items_update_self" on public.practice_session_items
  for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.practice_sessions s
      where s.id = practice_session_items.session_id
        and s.user_id = auth.uid()
    )
  );

create policy "practice_session_items_delete_self" on public.practice_session_items
  for delete to authenticated using (user_id = auth.uid());

create policy "practice_events_select_self" on public.practice_events
  for select to authenticated using (user_id = auth.uid());

-- Same shape: if session_id is set it must reference the caller's own
-- session. Standalone events (no session_id) are allowed.
create policy "practice_events_insert_self" on public.practice_events
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and (
      session_id is null
      or exists (
        select 1 from public.practice_sessions s
        where s.id = practice_events.session_id
          and s.user_id = auth.uid()
      )
    )
  );

create policy "streaks_select_self" on public.streaks
  for select to authenticated using (user_id = auth.uid());
create policy "streaks_insert_self" on public.streaks
  for insert to authenticated with check (user_id = auth.uid());
create policy "streaks_update_self" on public.streaks
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Notifications: members can read their own queue, but only the service role
-- (notification worker) writes them.
create policy "notification_events_select_self" on public.notification_events
  for select to authenticated using (user_id = auth.uid());
