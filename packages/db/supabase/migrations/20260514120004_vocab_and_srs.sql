-- Vocabulary is household-shared (extracted from a lesson once) but everything
-- downstream — "I already know this", FSRS state, review history — is per-user.
-- That split is the whole point: shared lesson, separate brains.

create type public.card_state as enum (
  'new',
  'learning',
  'review',
  'relearning'
);

create type public.review_rating as enum (
  'again',
  'hard',
  'good',
  'easy'
);

create table public.vocab_items (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  lesson_id uuid references public.lessons(id) on delete set null,
  lemma text not null,
  reading text,
  translation text,
  part_of_speech text,
  example_sentence text,
  example_translation text,
  audio_storage_bucket text,
  audio_storage_path text,
  difficulty integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Dedupe vocab inside a household. Treat null readings as empty so the unique
-- index can compare them. lower(lemma) collapses case-only duplicates.
create unique index vocab_items_household_lemma_uniq
  on public.vocab_items (household_id, lower(lemma), coalesce(reading, ''));
create index vocab_items_household_id_idx on public.vocab_items(household_id);
create index vocab_items_lesson_id_idx on public.vocab_items(lesson_id);

create trigger vocab_items_set_updated_at
  before update on public.vocab_items
  for each row execute function public.set_updated_at();

-- "I already know this word" — set when a user explicitly opts out of SRS for
-- a given vocab item. Per-user; the partner's mark doesn't affect their queue.
create table public.user_known_words (
  user_id uuid not null references auth.users(id) on delete cascade,
  vocab_item_id uuid not null references public.vocab_items(id) on delete cascade,
  source text not null default 'self_report',
  marked_at timestamptz not null default now(),
  primary key (user_id, vocab_item_id)
);

create index user_known_words_user_id_idx on public.user_known_words(user_id);
create index user_known_words_vocab_item_id_idx on public.user_known_words(vocab_item_id);

-- One FSRS card per user per vocab item.
create table public.cards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  vocab_item_id uuid not null references public.vocab_items(id) on delete cascade,
  state public.card_state not null default 'new',
  due_at timestamptz not null default now(),
  stability real not null default 0,
  difficulty real not null default 0,
  reps integer not null default 0,
  lapses integer not null default 0,
  scheduled_days integer not null default 0,
  elapsed_days integer not null default 0,
  last_reviewed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, vocab_item_id)
);

create index cards_user_due_idx on public.cards(user_id, due_at);
create index cards_user_state_idx on public.cards(user_id, state);
create index cards_vocab_item_id_idx on public.cards(vocab_item_id);

create trigger cards_set_updated_at
  before update on public.cards
  for each row execute function public.set_updated_at();

create table public.card_reviews (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.cards(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  rating public.review_rating not null,
  elapsed_ms integer,
  reviewed_at timestamptz not null default now(),
  previous_state public.card_state,
  previous_stability real,
  previous_difficulty real,
  next_state public.card_state,
  next_stability real,
  next_difficulty real,
  next_due_at timestamptz,
  metadata jsonb not null default '{}'::jsonb
);

create index card_reviews_card_id_idx on public.card_reviews(card_id);
create index card_reviews_user_reviewed_idx on public.card_reviews(user_id, reviewed_at desc);

alter table public.vocab_items enable row level security;
alter table public.user_known_words enable row level security;
alter table public.cards enable row level security;
alter table public.card_reviews enable row level security;

-- Vocab items: household-shared CRUD.
create policy "vocab_items_select_household" on public.vocab_items
  for select to authenticated
  using (household_id = public.current_household_id());

create policy "vocab_items_insert_household" on public.vocab_items
  for insert to authenticated
  with check (household_id = public.current_household_id());

create policy "vocab_items_update_household" on public.vocab_items
  for update to authenticated
  using (household_id = public.current_household_id())
  with check (household_id = public.current_household_id());

create policy "vocab_items_delete_household" on public.vocab_items
  for delete to authenticated
  using (household_id = public.current_household_id());

-- Per-user learning state: a user only ever sees and writes their own rows.
create policy "user_known_words_select_self" on public.user_known_words
  for select to authenticated using (user_id = auth.uid());
create policy "user_known_words_insert_self" on public.user_known_words
  for insert to authenticated with check (user_id = auth.uid());
create policy "user_known_words_delete_self" on public.user_known_words
  for delete to authenticated using (user_id = auth.uid());

create policy "cards_select_self" on public.cards
  for select to authenticated using (user_id = auth.uid());
create policy "cards_insert_self" on public.cards
  for insert to authenticated with check (user_id = auth.uid());
create policy "cards_update_self" on public.cards
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
create policy "cards_delete_self" on public.cards
  for delete to authenticated using (user_id = auth.uid());

create policy "card_reviews_select_self" on public.card_reviews
  for select to authenticated using (user_id = auth.uid());

-- A review must point at one of the caller's own cards. Without the EXISTS
-- check a client that learns another user's card UUID could insert reviews
-- under its own user_id and pollute that card's scheduling / analytics.
create policy "card_reviews_insert_self" on public.card_reviews
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.cards c
      where c.id = card_reviews.card_id
        and c.user_id = auth.uid()
    )
  );
