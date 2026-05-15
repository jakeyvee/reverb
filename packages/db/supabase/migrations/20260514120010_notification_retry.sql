-- Lesson retry + in-app notification surface (VOL-114).
--
-- The notification_events table from migration 20260514120006 already supports
-- per-user delivery rows but didn't carry a back-reference to the lesson and
-- couldn't model the `lesson_failed` state. VOL-114 wires those gaps:
--
--   * Adds `lesson_failed` to `notification_event_kind` and `in_app` to
--     `notification_channel` so the worker can persist in-app records before
--     email/push are wired up.
--   * Adds `lesson_id` / `read_at` columns plus an unread index so the app
--     shell can render a badge count and the user can dismiss rows.
--   * Adds a partial unique index keyed on (user_id, lesson_id, kind) so the
--     worker can `upsert ... on conflict do nothing` from any context — the
--     normal completion path, a Trigger.dev retry, or a manual re-enqueue —
--     without duplicating in-app records.
--   * Lets authenticated members `update` their own notification rows so the
--     "mark as read" affordance works without going through the service role.
--
-- The enum + table changes are additive so existing rows and policies keep
-- their shape.

alter type public.notification_event_kind add value if not exists 'lesson_failed';
alter type public.notification_channel add value if not exists 'in_app';

alter table public.notification_events
  add column lesson_id uuid references public.lessons(id) on delete cascade,
  add column read_at timestamptz;

create index notification_events_lesson_id_idx
  on public.notification_events(lesson_id);

-- The badge in the app shell pulls "unread" via this index, so it stays cheap
-- even as the table grows.
create index notification_events_user_unread_idx
  on public.notification_events(user_id, created_at desc)
  where read_at is null;

-- Idempotency guard for lesson-scoped notifications: the worker upserts with
-- `on conflict do nothing`, so a retry that re-completes / re-fails a lesson
-- never produces duplicate rows for the same (user, lesson, kind) triple.
-- Streak / milestone notifications are unscoped to a specific lesson and stay
-- out of this index.
create unique index notification_events_lesson_kind_uniq
  on public.notification_events (user_id, lesson_id, kind)
  where lesson_id is not null;

-- Members can flip their own notification rows to read. They still cannot
-- create or delete rows — those are reserved for the service role.
create policy "notification_events_update_self_read" on public.notification_events
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
