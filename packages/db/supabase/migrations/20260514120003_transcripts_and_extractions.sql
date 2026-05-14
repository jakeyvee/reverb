-- Per-lesson outputs from the speech + LLM pipeline. All household-shared:
-- both members of a household see the same transcript and extraction runs.

create type public.extraction_run_kind as enum (
  'vocab',
  'grammar',
  'dialogue',
  'corrections'
);

create type public.extraction_run_status as enum (
  'queued',
  'running',
  'succeeded',
  'failed'
);

create table public.transcript_segments (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references public.lessons(id) on delete cascade,
  segment_index integer not null,
  start_ms integer not null,
  end_ms integer not null,
  speaker text,
  language text,
  text text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (lesson_id, segment_index),
  constraint transcript_segments_time_range_check check (end_ms >= start_ms)
);

create index transcript_segments_lesson_id_idx on public.transcript_segments(lesson_id);
create index transcript_segments_lesson_start_idx on public.transcript_segments(lesson_id, start_ms);

create table public.transcript_words (
  id uuid primary key default gen_random_uuid(),
  segment_id uuid not null references public.transcript_segments(id) on delete cascade,
  lesson_id uuid not null references public.lessons(id) on delete cascade,
  word_index integer not null,
  start_ms integer not null,
  end_ms integer not null,
  text text not null,
  confidence real,
  created_at timestamptz not null default now(),
  unique (segment_id, word_index),
  constraint transcript_words_time_range_check check (end_ms >= start_ms)
);

create index transcript_words_segment_id_idx on public.transcript_words(segment_id);
create index transcript_words_lesson_id_idx on public.transcript_words(lesson_id);

create table public.extraction_runs (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null references public.lessons(id) on delete cascade,
  kind public.extraction_run_kind not null,
  status public.extraction_run_status not null default 'queued',
  model text,
  prompt_version text,
  input jsonb not null default '{}'::jsonb,
  output jsonb not null default '{}'::jsonb,
  error text,
  cost_cents integer,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index extraction_runs_lesson_id_idx on public.extraction_runs(lesson_id);
create index extraction_runs_kind_status_idx on public.extraction_runs(kind, status);

create trigger extraction_runs_set_updated_at
  before update on public.extraction_runs
  for each row execute function public.set_updated_at();

alter table public.transcript_segments enable row level security;
alter table public.transcript_words enable row level security;
alter table public.extraction_runs enable row level security;

-- All three are read-only to members; pipeline workers write via service role.
create policy "transcript_segments_select_household" on public.transcript_segments
  for select to authenticated
  using (
    exists (
      select 1 from public.lessons l
      where l.id = transcript_segments.lesson_id
        and l.household_id = public.current_household_id()
    )
  );

create policy "transcript_words_select_household" on public.transcript_words
  for select to authenticated
  using (
    exists (
      select 1 from public.lessons l
      where l.id = transcript_words.lesson_id
        and l.household_id = public.current_household_id()
    )
  );

create policy "extraction_runs_select_household" on public.extraction_runs
  for select to authenticated
  using (
    exists (
      select 1 from public.lessons l
      where l.id = extraction_runs.lesson_id
        and l.household_id = public.current_household_id()
    )
  );
