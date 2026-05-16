-- VOL-135: monthly streak free-pass + idempotent reminder email log.
--
-- Two small tables that live alongside `streaks` and `notification_events`:
--
--   * `streak_free_pass_uses` — one row per user per calendar month captures
--     a consumed free-pass token. The PRD allots each user one token per
--     calendar month; existence of a row for (user_id, month_key) means the
--     token has been spent. The primary key blocks a second consumption
--     within the same month even if the orchestrator gets called twice.
--
--   * `streak_reminder_log` — one row per user per local-day captures the
--     fact that the reminder dispatcher already fired for that user/day.
--     The unique pk is what makes the cron route idempotent: a re-run for
--     the same date is a no-op insert.
--
-- The reminder dispatcher writes into both `notification_events` (so the
-- in-app notifications surface picks the row up) AND `streak_reminder_log`
-- (so the cron knows not to re-send). Two tables instead of one because the
-- existing notification_events idempotency index is keyed on lesson rows;
-- adding another partial unique index there would entangle two unrelated
-- use cases.

create table public.streak_free_pass_uses (
  user_id uuid not null references auth.users(id) on delete cascade,
  -- ISO calendar month in the user's local timezone, e.g. '2026-05'. Stored
  -- as text rather than a date+truncate so the local-month semantics are
  -- explicit and don't depend on the column's storage timezone.
  month_key text not null check (month_key ~ '^[0-9]{4}-[0-9]{2}$'),
  -- The local-date the user was given credit for (the day the free-pass
  -- "covered"). Useful for audit + the UI's "applied to Tuesday" copy.
  applied_for_date date not null,
  -- The local-date the consumption happened (today, in the user's TZ).
  used_on date not null,
  -- Best-effort link back to the session whose completion triggered the
  -- auto-apply. Nullable so a manual / future surface can also burn the
  -- token without inventing a synthetic session.
  session_id uuid references public.practice_sessions(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id, month_key)
);

create index streak_free_pass_uses_user_idx
  on public.streak_free_pass_uses(user_id, used_on desc);

alter table public.streak_free_pass_uses enable row level security;

-- Members may read their own free-pass history (the home UI surfaces how
-- many tokens remain). Writes are reserved for the service role / server
-- action path that also bumps the streak row.
create policy "streak_free_pass_uses_select_self" on public.streak_free_pass_uses
  for select to authenticated using (user_id = auth.uid());

create table public.streak_reminder_log (
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Local-date the reminder was *for*. Two reminders intended for the same
  -- local day collapse into the same row, which is the whole point of the
  -- table.
  reminder_date date not null,
  channel public.notification_channel not null default 'email',
  notification_event_id uuid references public.notification_events(id) on delete set null,
  sent_at timestamptz not null default now(),
  primary key (user_id, reminder_date, channel)
);

create index streak_reminder_log_user_idx
  on public.streak_reminder_log(user_id, reminder_date desc);

alter table public.streak_reminder_log enable row level security;

-- Members may read their own reminder history. Writes happen from the
-- service-role-backed cron route.
create policy "streak_reminder_log_select_self" on public.streak_reminder_log
  for select to authenticated using (user_id = auth.uid());
