-- Local-dev seed. Runs after migrations on `supabase db reset`.
--
-- Creates two whitelisted users in the same household plus a demo lesson
-- shell. Both users sign in with password "reverb-local" via email link.
-- Fixed UUIDs make the seed idempotent and easy to script against from
-- integration tests.

insert into auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at,
  confirmation_token,
  email_change,
  email_change_token_new,
  recovery_token
) values
  (
    '00000000-0000-0000-0000-000000000000',
    '11111111-1111-1111-1111-111111111111',
    'authenticated',
    'authenticated',
    'alice@reverb.local',
    crypt('reverb-local', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Alice"}'::jsonb,
    now(),
    now(),
    '',
    '',
    '',
    ''
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '22222222-2222-2222-2222-222222222222',
    'authenticated',
    'authenticated',
    'bob@reverb.local',
    crypt('reverb-local', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"display_name":"Bob"}'::jsonb,
    now(),
    now(),
    '',
    '',
    '',
    ''
  )
on conflict (id) do nothing;

-- `id` is intentionally omitted so the table default applies (its column type
-- has changed across Supabase versions). The unique key is (provider, provider_id).
insert into auth.identities (
  user_id,
  provider_id,
  identity_data,
  provider,
  last_sign_in_at,
  created_at,
  updated_at
) values
  (
    '11111111-1111-1111-1111-111111111111',
    '11111111-1111-1111-1111-111111111111',
    jsonb_build_object(
      'sub', '11111111-1111-1111-1111-111111111111',
      'email', 'alice@reverb.local',
      'email_verified', true
    ),
    'email',
    now(),
    now(),
    now()
  ),
  (
    '22222222-2222-2222-2222-222222222222',
    '22222222-2222-2222-2222-222222222222',
    jsonb_build_object(
      'sub', '22222222-2222-2222-2222-222222222222',
      'email', 'bob@reverb.local',
      'email_verified', true
    ),
    'email',
    now(),
    now(),
    now()
  )
on conflict (provider, provider_id) do nothing;

insert into public.households (id, name)
values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Reverb House')
on conflict (id) do nothing;

insert into public.profiles (id, household_id, display_name, locale, timezone)
values
  (
    '11111111-1111-1111-1111-111111111111',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'Alice',
    'en-US',
    'America/Los_Angeles'
  ),
  (
    '22222222-2222-2222-2222-222222222222',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'Bob',
    'en-US',
    'America/Los_Angeles'
  )
on conflict (id) do nothing;

insert into public.lessons (
  id,
  household_id,
  title,
  description,
  source_language,
  target_language,
  status,
  created_by
) values (
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'Demo Lesson',
  'Placeholder lesson shell for local development.',
  'en',
  'ja',
  'draft',
  '11111111-1111-1111-1111-111111111111'
)
on conflict (id) do nothing;
