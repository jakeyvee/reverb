-- Reverb baseline: extensions, household + profile model, and RLS helpers.
--
-- Profiles map 1:1 to auth.users and pin each user to a single household. Every
-- household-shared table later joins through profiles.household_id, so the
-- `current_household_id()` helper is the single source of truth for those
-- policies. It runs as SECURITY DEFINER so it can read profiles without
-- recursing into profiles' own RLS.

create extension if not exists "pgcrypto" with schema public;

-- Generic updated_at trigger used by every table that exposes the column.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger households_set_updated_at
  before update on public.households
  for each row execute function public.set_updated_at();

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete restrict,
  display_name text not null,
  avatar_url text,
  locale text,
  timezone text not null default 'UTC',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index profiles_household_id_idx on public.profiles(household_id);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Resolves the household of the currently authenticated user. Returns null for
-- anon callers (no profile row), which collapses every household-scoped policy
-- to `false`. SECURITY DEFINER + locked search_path avoids RLS recursion when
-- this is referenced from profiles' own policies.
create or replace function public.current_household_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select household_id from public.profiles where id = auth.uid()
$$;

revoke all on function public.current_household_id() from public;
grant execute on function public.current_household_id() to authenticated, service_role;

alter table public.households enable row level security;
alter table public.profiles enable row level security;

-- Households: a member may read their own row. Inserts / updates are reserved
-- for the service role (seed + admin flows).
create policy "households_select_own" on public.households
  for select to authenticated
  using (id = public.current_household_id());

-- Profiles: members may read every profile inside their household so the UI
-- can render the partner. A user may only update their own row, and only
-- within their existing household (no jumping households client-side).
create policy "profiles_select_same_household" on public.profiles
  for select to authenticated
  using (household_id = public.current_household_id());

create policy "profiles_update_self" on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid() and household_id = public.current_household_id());
