-- Local-dev seed. Runs after migrations on `supabase db reset`.
--
-- Sets up the MVP smoke-test fixture (VOL-124):
--   * Two whitelisted users (alice/bob) in a single household.
--   * One demo traveler-Bahasa lesson marked `metadata.demo = true` with a
--     small transcript, vocab, and teacher corrections.
--   * Per-user `cards` (vocab) and `correction_drills` (mistake drills) for
--     both users, all due now so /session has work waiting on first load.
--
-- Both users sign in with password `reverb-local` via the email/password
-- form on /sign-in. Fixed UUIDs make the seed idempotent and easy to script
-- against from integration tests / smoke checks.
--
-- The demo lesson never enters the processing pipeline: the lesson_jobs row
-- is inserted at status `ready`, and the upload / retry / reprocess actions
-- refuse rows tagged `metadata.demo = true` (see apps/web/lib/lessons/demo.ts).

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

insert into public.profiles (id, household_id, display_name, locale, timezone, onboarded_at)
values
  (
    '11111111-1111-1111-1111-111111111111',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'Alice',
    'en-US',
    'America/Los_Angeles',
    now()
  ),
  (
    '22222222-2222-2222-2222-222222222222',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'Bob',
    'en-US',
    'America/Los_Angeles',
    now()
  )
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Demo lesson (VOL-124): a short traveler-Bahasa fixture so /session has work
-- to do without an actual upload. The `metadata.demo` flag is the marker that
-- excludes this lesson from any worker-driven processing path.
-- ---------------------------------------------------------------------------

insert into public.lessons (
  id,
  household_id,
  title,
  description,
  source_language,
  target_language,
  status,
  duration_ms,
  created_by,
  metadata
) values (
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  'Demo: Traveler''s Bahasa — Day 1',
  'Pre-seeded sample lesson so a fresh install has something to practice. Replace by uploading a real recording.',
  'en',
  'id',
  'ready',
  240000,
  '11111111-1111-1111-1111-111111111111',
  jsonb_build_object(
    'demo', true,
    'source', jsonb_build_object('kind', 'seed', 'fixture', 'vol-124-traveler-bahasa')
  )
)
on conflict (id) do update set
  status = excluded.status,
  description = excluded.description,
  source_language = excluded.source_language,
  target_language = excluded.target_language,
  duration_ms = excluded.duration_ms,
  metadata = excluded.metadata;

-- A lesson_jobs row at status='ready' makes the demo lesson appear in the
-- household archive (the archive query joins lesson_jobs with !inner). No
-- worker ever runs against it because the demo flag short-circuits enqueue
-- paths and nothing dispatches a Trigger.dev run for this id.
insert into public.lesson_jobs (
  lesson_id,
  status,
  idempotency_key,
  attempt_count,
  provider_metadata,
  payload,
  started_at,
  finished_at
) values (
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'ready',
  'process_lesson:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  1,
  jsonb_build_object(
    'demo', true,
    'stages', jsonb_build_object(
      'transcribing', jsonb_build_object('completed_at', now()),
      'diarizing', jsonb_build_object('completed_at', now()),
      'extracting', jsonb_build_object('completed_at', now()),
      'generating_audio', jsonb_build_object('completed_at', now())
    )
  ),
  jsonb_build_object('demo', true),
  now() - interval '5 minutes',
  now() - interval '4 minutes'
)
on conflict (lesson_id) do update set
  status = excluded.status,
  provider_metadata = excluded.provider_metadata,
  finished_at = excluded.finished_at;

-- Tiny transcript — six segments of teacher + traveler banter so the
-- /lessons/<id> transcript view has something to render.
insert into public.transcript_segments (
  id,
  lesson_id,
  segment_index,
  start_ms,
  end_ms,
  speaker,
  speaker_confidence,
  language,
  text
) values
  ('cccccccc-0000-0000-0000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 0,      0,  6000, 'teacher', 0.95, 'id', 'Halo! Hari ini kita belajar untuk pergi ke kafe dan memesan minuman.'),
  ('cccccccc-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 1,   6000, 14000, 'teacher', 0.93, 'id', 'Coba ulangi: "Permisi, saya mau pesan kopi, tolong."'),
  ('cccccccc-0000-0000-0000-000000000003', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 2,  14000, 22000, 'student', 0.88, 'id', 'Permisi, aku mau pesan kopi.'),
  ('cccccccc-0000-0000-0000-000000000004', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 3,  22000, 33000, 'teacher', 0.94, 'id', 'Bagus, tetapi dalam situasi sopan kita pakai "saya", bukan "aku". Coba lagi.'),
  ('cccccccc-0000-0000-0000-000000000005', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 4,  33000, 41000, 'student', 0.90, 'id', 'Permisi, saya mau pesan kopi, tolong. Berapa harganya?'),
  ('cccccccc-0000-0000-0000-000000000006', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 5,  41000, 52000, 'teacher', 0.95, 'id', 'Sempurna. Kalau enak, kamu bisa bilang "Enak sekali, terima kasih!"')
on conflict (id) do nothing;

-- Vocab items: deterministic UUIDs so the cards (below) can reference them.
-- All lemmas are unique within the household so the vocab_items unique index
-- (household_id, lower(lemma), coalesce(reading, '')) is happy.
insert into public.vocab_items (
  id,
  household_id,
  lesson_id,
  lemma,
  reading,
  translation,
  part_of_speech,
  example_sentence,
  example_translation,
  difficulty
) values
  ('dddddddd-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'halo',          null, 'hello',                          'interjection', 'Halo, apa kabar?',                      'Hello, how are you?',                          1),
  ('dddddddd-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'terima kasih',  null, 'thank you',                      'phrase',       'Terima kasih banyak.',                  'Thank you very much.',                          1),
  ('dddddddd-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'permisi',       null, 'excuse me',                      'interjection', 'Permisi, saya mau pesan kopi.',         'Excuse me, I would like to order coffee.',      1),
  ('dddddddd-0000-0000-0000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'berapa harganya', null, 'how much is it?',              'phrase',       'Berapa harganya kopi ini?',             'How much is this coffee?',                      2),
  ('dddddddd-0000-0000-0000-000000000005', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'di mana toilet', null, 'where is the toilet?',          'phrase',       'Permisi, di mana toilet?',              'Excuse me, where is the toilet?',               2),
  ('dddddddd-0000-0000-0000-000000000006', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'air',           null, 'water',                          'noun',         'Tolong, satu air putih.',               'One glass of plain water, please.',             1),
  ('dddddddd-0000-0000-0000-000000000007', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'enak',          null, 'delicious',                      'adjective',    'Kopi ini enak sekali.',                 'This coffee is really delicious.',              1),
  ('dddddddd-0000-0000-0000-000000000008', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'saya tidak mengerti', null, 'I don''t understand',         'phrase',       'Maaf, saya tidak mengerti.',            'Sorry, I don''t understand.',                   2)
on conflict (household_id, lower(lemma), coalesce(reading, '')) do nothing;

-- Per-user FSRS cards. State='new', due_at='epoch' so every card is due
-- immediately on first /session load. Both users get an independent row for
-- each vocab item so partner progress never leaks.
insert into public.cards (
  id,
  user_id,
  vocab_item_id,
  state,
  due_at,
  stability,
  difficulty,
  reps,
  lapses,
  scheduled_days,
  elapsed_days
)
select
  -- UUID layout is 8-4-4-4-12; concatenation must produce exactly that.
  ('eeeeeeee-' || lpad(user_idx::text, 4, '0') || '-0000-0000-' || lpad(vocab_idx::text, 12, '0'))::uuid,
  user_id::uuid,
  vocab_id::uuid,
  'new'::public.card_state,
  '1970-01-01T00:00:00Z'::timestamptz,
  0,
  0,
  0,
  0,
  0,
  0
from (
  values
    (1, '11111111-1111-1111-1111-111111111111'),
    (2, '22222222-2222-2222-2222-222222222222')
) as users(user_idx, user_id)
cross join (
  values
    (1, 'dddddddd-0000-0000-0000-000000000001'),
    (2, 'dddddddd-0000-0000-0000-000000000002'),
    (3, 'dddddddd-0000-0000-0000-000000000003'),
    (4, 'dddddddd-0000-0000-0000-000000000004'),
    (5, 'dddddddd-0000-0000-0000-000000000005'),
    (6, 'dddddddd-0000-0000-0000-000000000006'),
    (7, 'dddddddd-0000-0000-0000-000000000007'),
    (8, 'dddddddd-0000-0000-0000-000000000008')
) as vocab(vocab_idx, vocab_id)
on conflict (user_id, vocab_item_id) do nothing;

-- Teacher corrections — the source rows that drive mistake drills. Confidence
-- is well above CORRECTION_DRILL_MIN_CONFIDENCE (0.3) so the session loader
-- keeps every drill eligible for review.
insert into public.teacher_corrections (
  id,
  household_id,
  lesson_id,
  segment_id,
  kind,
  source_text,
  corrected_text,
  explanation,
  confidence
) values
  (
    'ffffffff-0000-0000-0000-000000000001',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    'cccccccc-0000-0000-0000-000000000003',
    'usage',
    'aku mau pesan kopi',
    'saya mau pesan kopi',
    'Use "saya" instead of "aku" when speaking with someone you don''t know — it''s the polite first-person pronoun.',
    0.92
  ),
  (
    'ffffffff-0000-0000-0000-000000000002',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    'cccccccc-0000-0000-0000-000000000003',
    'grammar',
    'aku mau pesan kopi',
    'aku mau pesan kopi, tolong',
    'Adding "tolong" softens a request — without it the sentence sounds like a command rather than an order.',
    0.85
  ),
  (
    'ffffffff-0000-0000-0000-000000000003',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    'cccccccc-0000-0000-0000-000000000005',
    'vocabulary',
    'Berapa harganya?',
    'Berapa harganya kopi ini?',
    'Be specific about what you''re asking the price of — otherwise the cashier won''t know which item you mean.',
    0.78
  )
on conflict (lesson_id, kind, source_text, corrected_text) do nothing;

-- Mistake-drill rows for each user. due_at=epoch so they're due immediately
-- and queue ahead of vocab cards on the daily session orchestrator.
insert into public.correction_drills (
  id,
  user_id,
  teacher_correction_id,
  state,
  due_at
)
select
  -- UUID layout is 8-4-4-4-12; concatenation must produce exactly that.
  ('99999999-' || lpad(user_idx::text, 4, '0') || '-0000-0000-' || lpad(correction_idx::text, 12, '0'))::uuid,
  user_id::uuid,
  correction_id::uuid,
  'new'::public.correction_drill_state,
  '1970-01-01T00:00:00Z'::timestamptz
from (
  values
    (1, '11111111-1111-1111-1111-111111111111'),
    (2, '22222222-2222-2222-2222-222222222222')
) as users(user_idx, user_id)
cross join (
  values
    (1, 'ffffffff-0000-0000-0000-000000000001'),
    (2, 'ffffffff-0000-0000-0000-000000000002'),
    (3, 'ffffffff-0000-0000-0000-000000000003')
) as corrections(correction_idx, correction_id)
on conflict (user_id, teacher_correction_id) do nothing;
