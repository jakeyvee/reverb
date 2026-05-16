-- Observability + cost guardrails (VOL-138).
--
-- The product runs on three paid providers — Groq (ASR), Anthropic (LLM),
-- Google Cloud (TTS). The business goal is to stay under $30/month total spend
-- and to keep silent failures off the board. We log one row per outbound
-- provider call into `provider_usage_events` with the minimum fields needed
-- to (a) attribute usage to a household / lesson / surface, (b) estimate cost
-- from public per-unit rates frozen at insert time, and (c) flag failures so
-- the worker logs aren't the only place errors live.
--
-- The two reporting views are the "cost dashboard": `provider_usage_monthly`
-- aggregates events by month / provider / operation so the operator can run a
-- single SELECT in Supabase Studio to see whether the projected month is
-- inside the cap. `lesson_processing_latency` exposes the upload→ready
-- latency carried by `lesson_jobs` timestamps so a stuck or failing lesson is
-- discoverable without joining tables by hand.
--
-- The table is service-role-only on writes and reads (no select policy).
-- Telemetry that crosses every household stays off the authenticated surface
-- on purpose — there is no per-user view of the data; the operator queries
-- it via the Supabase service role.

create table public.provider_usage_events (
  id uuid primary key default gen_random_uuid(),
  -- Optional links so a future audit can answer "which lesson drove this
  -- token bill?" without rebuilding the join from logs. ON DELETE SET NULL
  -- keeps historical rows queryable even after a household / lesson is
  -- deleted — useful for the monthly cost roll-up across the full window.
  household_id uuid references public.households(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,
  lesson_id uuid references public.lessons(id) on delete set null,
  -- 'groq-whisper' | 'anthropic-diarization' | 'anthropic-extraction' |
  -- 'anthropic-conversation' | 'google-tts'. The provider id mirrors the
  -- *_PROVIDER_ID constants exported from @reverb/ai so the schema stays
  -- aligned with the code.
  provider text not null,
  -- 'asr' | 'llm' | 'tts'. Lets the cost view group across providers that
  -- bill on the same unit (Anthropic and Groq both bill on tokens for chat,
  -- Google bills on characters).
  operation text not null,
  -- Model name actually used. Anthropic prices vary by model so the view
  -- keys cost summaries on this column too.
  model text,
  -- Free-form context — 'lesson-pipeline.transcribing', 'chat', etc. — so
  -- a future query can attribute spend to a specific surface.
  surface text not null,
  -- 'succeeded' | 'failed'. Failed rows still get logged so error rate is
  -- a first-class metric.
  status text not null default 'succeeded',
  -- ASR-only: duration of the audio passed to the model in milliseconds.
  audio_duration_ms integer,
  -- LLM-only: token counts as reported by the provider response.
  input_tokens integer,
  output_tokens integer,
  -- TTS-only: number of characters synthesised. Google bills per character.
  character_count integer,
  -- End-to-end latency for the provider call in milliseconds. NULL when the
  -- recorder could not time the call (e.g. an exception thrown before the
  -- timer stopped).
  latency_ms integer,
  -- Estimated cost frozen at the time of the call, stored in micro-USD
  -- (1/1,000,000) so per-call rounding to a cent does not erase signal —
  -- a single Anthropic input token is currently ~3 micro-USD on Sonnet.
  -- BIGINT covers a year of operation at any plausible volume.
  cost_micro_usd bigint,
  -- Short user-facing error summary for `status = 'failed'` rows. Long
  -- stack traces stay in the worker / web log.
  error text,
  -- Free-form provider metadata (response id, voice, language code, etc.)
  -- for ad-hoc debugging without re-running the request.
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Most analytical reads slice by time. Per-provider monthly aggregates also
-- slice by provider, and household-attribution queries slice by household.
create index provider_usage_events_created_at_idx
  on public.provider_usage_events (created_at desc);
create index provider_usage_events_provider_created_idx
  on public.provider_usage_events (provider, created_at desc);
create index provider_usage_events_household_created_idx
  on public.provider_usage_events (household_id, created_at desc);
create index provider_usage_events_status_idx
  on public.provider_usage_events (status) where status = 'failed';

alter table public.provider_usage_events enable row level security;

-- No SELECT / INSERT policy is intentional: only the service role writes and
-- only the service role reads. The operator queries through Supabase Studio
-- (which uses the service role) or via a back-office tool.

-- Monthly cost roll-up. The "cost dashboard or query" called out in VOL-138
-- is just this view: select * from provider_usage_monthly where month >=
-- date_trunc('month', now()). Tracks succeeded events (the ones that cost
-- money) separately from failed ones so a flap doesn't inflate the bill.
create or replace view public.provider_usage_monthly as
select
  date_trunc('month', created_at) as month,
  provider,
  operation,
  model,
  count(*) filter (where status = 'succeeded') as succeeded_count,
  count(*) filter (where status = 'failed') as failed_count,
  coalesce(sum(audio_duration_ms) filter (where status = 'succeeded'), 0)::bigint
    as audio_duration_ms_sum,
  coalesce(sum(input_tokens) filter (where status = 'succeeded'), 0)::bigint
    as input_tokens_sum,
  coalesce(sum(output_tokens) filter (where status = 'succeeded'), 0)::bigint
    as output_tokens_sum,
  coalesce(sum(character_count) filter (where status = 'succeeded'), 0)::bigint
    as character_count_sum,
  coalesce(sum(cost_micro_usd) filter (where status = 'succeeded'), 0)::bigint
    as cost_micro_usd_sum,
  -- Convenience: round-trip to dollars at four decimal places so the operator
  -- doesn't have to divide by a million in their head.
  (coalesce(sum(cost_micro_usd) filter (where status = 'succeeded'), 0)::numeric / 1000000)
    as cost_usd_sum
from public.provider_usage_events
group by 1, 2, 3, 4
order by 1 desc, 2, 3, 4;

-- End-to-end lesson processing latency. Drives the "Lesson processing latency
-- is recorded from upload to ready" acceptance criterion: the timestamps
-- already live on lesson_jobs, this view just exposes them as durations so a
-- query of the form `select avg(latency_ms) from lesson_processing_latency
-- where finished_at > now() - interval '7 days'` is one line.
create or replace view public.lesson_processing_latency as
select
  lj.id as job_id,
  lj.lesson_id,
  l.household_id,
  lj.status,
  lj.attempt_count,
  lj.queued_at,
  lj.started_at,
  lj.finished_at,
  lj.failed_at,
  lj.error_summary,
  -- Upload → ready end-to-end (NULL for in-flight or failed runs).
  case
    when lj.finished_at is not null
      then (extract(epoch from (lj.finished_at - lj.queued_at)) * 1000)::bigint
  end as latency_ms,
  -- Time spent inside the worker — excludes the queue wait, so a long
  -- pipeline can be distinguished from a slow Trigger.dev dispatch.
  case
    when lj.finished_at is not null and lj.started_at is not null
      then (extract(epoch from (lj.finished_at - lj.started_at)) * 1000)::bigint
  end as worker_latency_ms,
  case
    when lj.failed_at is not null
      then (extract(epoch from (lj.failed_at - lj.queued_at)) * 1000)::bigint
  end as failure_latency_ms
from public.lesson_jobs lj
join public.lessons l on l.id = lj.lesson_id;

comment on table public.provider_usage_events is
  'One row per outbound paid-provider call. Drives provider_usage_monthly for cost guardrails.';
comment on view public.provider_usage_monthly is
  'Monthly cost + volume roll-up keyed on (month, provider, operation, model).';
comment on view public.lesson_processing_latency is
  'Upload → ready latency per lesson_jobs row, with queue and worker portions broken out.';
