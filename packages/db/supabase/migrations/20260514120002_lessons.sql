-- Lessons are the household-shared unit of content. Files (raw audio, cleaned
-- transcript, thumbnails) and processing jobs (transcription, extraction, clip
-- generation, TTS) all hang off a lesson. Members of a household read and
-- write every row; the service role still bypasses RLS for background work.

create type public.lesson_status as enum (
  'draft',
  'uploading',
  'processing',
  'ready',
  'failed',
  'archived'
);

create type public.lesson_file_kind as enum (
  'audio_source',
  'audio_clean',
  'transcript_raw',
  'transcript_clean',
  'thumbnail'
);

create type public.lesson_job_kind as enum (
  'transcription',
  'extraction',
  'clip_generation',
  'tts'
);

create type public.lesson_job_status as enum (
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled'
);

create table public.lessons (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  title text not null,
  description text,
  source_language text,
  target_language text,
  recorded_at timestamptz,
  status public.lesson_status not null default 'draft',
  duration_ms integer,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index lessons_household_id_idx on public.lessons(household_id);
create index lessons_status_idx on public.lessons(status);
create index lessons_recorded_at_idx on public.lessons(household_id, recorded_at desc);

create trigger lessons_set_updated_at
  before update on public.lessons
  for each row execute function public.set_updated_at();

create table public.lesson_files (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references public.lessons(id) on delete cascade,
  kind public.lesson_file_kind not null,
  storage_bucket text not null,
  storage_path text not null,
  mime_type text,
  byte_size bigint,
  duration_ms integer,
  checksum text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (storage_bucket, storage_path)
);

create index lesson_files_lesson_id_idx on public.lesson_files(lesson_id);
create index lesson_files_kind_idx on public.lesson_files(lesson_id, kind);

create table public.lesson_jobs (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references public.lessons(id) on delete cascade,
  kind public.lesson_job_kind not null,
  status public.lesson_job_status not null default 'queued',
  trigger_run_id text,
  attempt_count integer not null default 0,
  error text,
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index lesson_jobs_lesson_id_idx on public.lesson_jobs(lesson_id);
create index lesson_jobs_status_idx on public.lesson_jobs(status);
create index lesson_jobs_trigger_run_id_idx on public.lesson_jobs(trigger_run_id);

create trigger lesson_jobs_set_updated_at
  before update on public.lesson_jobs
  for each row execute function public.set_updated_at();

alter table public.lessons enable row level security;
alter table public.lesson_files enable row level security;
alter table public.lesson_jobs enable row level security;

create policy "lessons_select_household" on public.lessons
  for select to authenticated
  using (household_id = public.current_household_id());

create policy "lessons_insert_household" on public.lessons
  for insert to authenticated
  with check (household_id = public.current_household_id());

create policy "lessons_update_household" on public.lessons
  for update to authenticated
  using (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());

create policy "lessons_delete_household" on public.lessons
  for delete to authenticated
  using (household_id = public.current_household_id());

create policy "lesson_files_select_household" on public.lesson_files
  for select to authenticated
  using (
    exists (
      select 1 from public.lessons l
      where l.id = lesson_files.lesson_id
        and l.household_id = public.current_household_id()
    )
  );

create policy "lesson_files_insert_household" on public.lesson_files
  for insert to authenticated
  with check (
    exists (
      select 1 from public.lessons l
      where l.id = lesson_files.lesson_id
        and l.household_id = public.current_household_id()
    )
  );

create policy "lesson_files_update_household" on public.lesson_files
  for update to authenticated
  using (
    exists (
      select 1 from public.lessons l
      where l.id = lesson_files.lesson_id
        and l.household_id = public.current_household_id()
    )
  );

create policy "lesson_files_delete_household" on public.lesson_files
  for delete to authenticated
  using (
    exists (
      select 1 from public.lessons l
      where l.id = lesson_files.lesson_id
        and l.household_id = public.current_household_id()
    )
  );

-- Members can observe job progress but never poke at job state directly.
-- All mutations come from Trigger.dev workers using the service role.
create policy "lesson_jobs_select_household" on public.lesson_jobs
  for select to authenticated
  using (
    exists (
      select 1 from public.lessons l
      where l.id = lesson_jobs.lesson_id
        and l.household_id = public.current_household_id()
    )
  );
