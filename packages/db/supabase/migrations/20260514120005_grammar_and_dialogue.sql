-- Grammar patterns, generated exercises, dialogue clips, and teacher
-- corrections are all extracted from the lesson and shared across the
-- household. Per-user attempts and scores live on practice_session_items.

create type public.grammar_exercise_kind as enum (
  'fill_blank',
  'multiple_choice',
  'translate',
  'reorder'
);

create type public.teacher_correction_kind as enum (
  'grammar',
  'vocabulary',
  'pronunciation',
  'usage'
);

create table public.grammar_patterns (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  lesson_id uuid references public.lessons(id) on delete set null,
  pattern text not null,
  description text,
  examples jsonb not null default '[]'::jsonb,
  difficulty integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index grammar_patterns_household_id_idx on public.grammar_patterns(household_id);
create index grammar_patterns_lesson_id_idx on public.grammar_patterns(lesson_id);

create trigger grammar_patterns_set_updated_at
  before update on public.grammar_patterns
  for each row execute function public.set_updated_at();

create table public.grammar_exercises (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  lesson_id uuid references public.lessons(id) on delete set null,
  grammar_pattern_id uuid references public.grammar_patterns(id) on delete cascade,
  kind public.grammar_exercise_kind not null,
  prompt text not null,
  answer text not null,
  choices jsonb not null default '[]'::jsonb,
  explanation text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index grammar_exercises_household_id_idx on public.grammar_exercises(household_id);
create index grammar_exercises_lesson_id_idx on public.grammar_exercises(lesson_id);
create index grammar_exercises_pattern_id_idx on public.grammar_exercises(grammar_pattern_id);

create trigger grammar_exercises_set_updated_at
  before update on public.grammar_exercises
  for each row execute function public.set_updated_at();

create table public.dialogue_clips (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  lesson_id uuid not null references public.lessons(id) on delete cascade,
  segment_id uuid references public.transcript_segments(id) on delete set null,
  start_ms integer not null,
  end_ms integer not null,
  storage_bucket text not null,
  storage_path text not null,
  caption text,
  translation text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint dialogue_clips_time_range_check check (end_ms >= start_ms),
  unique (storage_bucket, storage_path)
);

create index dialogue_clips_household_id_idx on public.dialogue_clips(household_id);
create index dialogue_clips_lesson_id_idx on public.dialogue_clips(lesson_id);

create table public.teacher_corrections (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  lesson_id uuid not null references public.lessons(id) on delete cascade,
  segment_id uuid references public.transcript_segments(id) on delete set null,
  kind public.teacher_correction_kind not null,
  source_text text not null,
  corrected_text text not null,
  explanation text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index teacher_corrections_household_id_idx on public.teacher_corrections(household_id);
create index teacher_corrections_lesson_id_idx on public.teacher_corrections(lesson_id);

alter table public.grammar_patterns enable row level security;
alter table public.grammar_exercises enable row level security;
alter table public.dialogue_clips enable row level security;
alter table public.teacher_corrections enable row level security;

create policy "grammar_patterns_select_household" on public.grammar_patterns
  for select to authenticated using (household_id = public.current_household_id());
create policy "grammar_patterns_insert_household" on public.grammar_patterns
  for insert to authenticated with check (household_id = public.current_household_id());
create policy "grammar_patterns_update_household" on public.grammar_patterns
  for update to authenticated
  using (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());
create policy "grammar_patterns_delete_household" on public.grammar_patterns
  for delete to authenticated using (household_id = public.current_household_id());

create policy "grammar_exercises_select_household" on public.grammar_exercises
  for select to authenticated using (household_id = public.current_household_id());
create policy "grammar_exercises_insert_household" on public.grammar_exercises
  for insert to authenticated with check (household_id = public.current_household_id());
create policy "grammar_exercises_update_household" on public.grammar_exercises
  for update to authenticated
  using (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());
create policy "grammar_exercises_delete_household" on public.grammar_exercises
  for delete to authenticated using (household_id = public.current_household_id());

create policy "dialogue_clips_select_household" on public.dialogue_clips
  for select to authenticated using (household_id = public.current_household_id());
create policy "dialogue_clips_insert_household" on public.dialogue_clips
  for insert to authenticated with check (household_id = public.current_household_id());
create policy "dialogue_clips_update_household" on public.dialogue_clips
  for update to authenticated
  using (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());
create policy "dialogue_clips_delete_household" on public.dialogue_clips
  for delete to authenticated using (household_id = public.current_household_id());

create policy "teacher_corrections_select_household" on public.teacher_corrections
  for select to authenticated using (household_id = public.current_household_id());
create policy "teacher_corrections_insert_household" on public.teacher_corrections
  for insert to authenticated with check (household_id = public.current_household_id());
create policy "teacher_corrections_update_household" on public.teacher_corrections
  for update to authenticated
  using (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());
create policy "teacher_corrections_delete_household" on public.teacher_corrections
  for delete to authenticated using (household_id = public.current_household_id());
