-- Lesson processing pipeline status model (VOL-108).
--
-- The placeholder `lesson_jobs` table from migration 20260514120002 modelled a
-- per-stage job (transcription, extraction, …). VOL-108 replaces it with a
-- single pipeline row per lesson whose `status` walks through the named stages
-- (queued → transcribing → diarizing → extracting → generating_audio → ready),
-- or terminates as `failed`. The new shape carries everything the worker and
-- UI need without joining sub-job rows: an idempotency key, retry counter,
-- provider metadata, and a user-facing error summary alongside the timestamps.
--
-- Members of a household can read job rows so the Lessons / Home status UI can
-- render progress, but every write still goes through the service role on
-- background workers. The single row per lesson is enforced by a unique
-- constraint on `lesson_id`, which also makes the worker's "upsert by lesson"
-- pattern safe against races.
--
-- Safe to drop-and-recreate: no production data exists yet and the only
-- in-tree writer (the upload server action) is updated in the same change set.

drop table if exists public.lesson_jobs cascade;
drop type if exists public.lesson_job_status;
drop type if exists public.lesson_job_kind;

create type public.lesson_processing_status as enum (
  'queued',
  'transcribing',
  'diarizing',
  'extracting',
  'generating_audio',
  'ready',
  'failed'
);

create table public.lesson_jobs (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null unique references public.lessons(id) on delete cascade,
  status public.lesson_processing_status not null default 'queued',
  -- Stable key for worker dedupe across retries and crash-recovery dispatches.
  -- Defaults to `process_lesson:<lesson_id>` when the web app inserts the row.
  idempotency_key text not null unique,
  attempt_count integer not null default 0,
  trigger_run_id text,
  -- Free-form provider details (model versions, transcription confidence,
  -- TTS voice, etc.). Writers append rather than overwrite when convenient.
  provider_metadata jsonb not null default '{}'::jsonb,
  -- Worker-supplied input snapshot (storage paths, language hints).
  payload jsonb not null default '{}'::jsonb,
  -- Short, user-facing failure summary. Long stack traces stay in worker logs.
  error_summary text,
  queued_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index lesson_jobs_status_idx on public.lesson_jobs(status);
create index lesson_jobs_trigger_run_id_idx on public.lesson_jobs(trigger_run_id);

create trigger lesson_jobs_set_updated_at
  before update on public.lesson_jobs
  for each row execute function public.set_updated_at();

alter table public.lesson_jobs enable row level security;

-- Read-only for household members. Workers mutate via service role.
create policy "lesson_jobs_select_household" on public.lesson_jobs
  for select to authenticated
  using (
    exists (
      select 1 from public.lessons l
      where l.id = lesson_jobs.lesson_id
        and l.household_id = public.current_household_id()
    )
  );
