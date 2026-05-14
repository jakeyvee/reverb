-- Onboarding + daily reminder preferences on profiles.
--
-- Profile bootstrap on first Google sign-in fills in the row with auth.users
-- metadata, then the web onboarding screen sets `onboarded_at` and the reminder
-- preference. The notification scheduler reads these columns when queueing
-- `streak_reminder` events.

alter table public.profiles
  add column if not exists reminder_enabled boolean not null default true,
  add column if not exists reminder_time time without time zone not null default '20:00:00',
  add column if not exists onboarded_at timestamptz;
