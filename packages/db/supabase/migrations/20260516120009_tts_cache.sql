-- TTS audio cache for vocab headwords (VOL-118).
--
-- Vocab cards are audio-first. The pipeline's `generating_audio` stage hits
-- Google Cloud Text-to-Speech for each new vocab item's lemma and stores the
-- resulting MP3 in the private `tts-cache` bucket. Multiple vocab_items in a
-- household can share the same audio (e.g. two lessons that both surface
-- "kopi") so we keep a content-addressed cache table here. The deterministic
-- storage path (`{householdId}/{provider}/{voice}/{hash}.mp3`) guarantees
-- that a retried generation step overwrites the same object instead of
-- littering the bucket.
--
-- The table is household-scoped to mirror the bucket policy from
-- 20260514120007_storage_buckets.sql — every TTS object lives under the
-- caller's household prefix and so does its catalog row. Service-role
-- workers bypass RLS for inserts; household members can only select their
-- own rows so the UI can resolve audio paths without leaking other
-- households' cached entries.

create table public.tts_assets (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  -- sha256 of the canonical text fed to the provider (lowercased + trimmed).
  -- Stored alongside the original text so backfills can re-hash if we ever
  -- change the canonicalisation rule.
  text_hash text not null,
  text text not null,
  language_code text not null,
  voice_name text not null,
  provider text not null,
  storage_bucket text not null,
  storage_path text not null,
  byte_size integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  -- One cache row per (household, content, voice). A different voice or a
  -- different text produces a different file; we never overwrite an entry
  -- with a different voice's audio.
  unique (household_id, text_hash, voice_name)
);

create index tts_assets_household_id_idx on public.tts_assets(household_id);

alter table public.tts_assets enable row level security;

-- Members can read their household's cache so the review UI can resolve
-- audio paths from a vocab_item to its cached storage object. All writes
-- happen via the service-role worker.
create policy "tts_assets_select_household" on public.tts_assets
  for select to authenticated
  using (household_id = public.current_household_id());
