-- ============================================================================
-- MockPrep — initial schema
--
--   users        one row per auth.users, created by trigger
--   sessions     one practice sitting — what "Recent sessions" lists
--   rounds       one question-and-answer exchange inside a session
--   scores       one row per session: overall plus the three sub-scores
--   transcripts  timestamped lines, optionally flagged
--
-- Every table has RLS on and is scoped to the owning user. Nothing here is
-- reachable without a session, guest sessions included.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------- enums

create type public.session_status as enum ('draft', 'live', 'scored', 'abandoned');
create type public.track          as enum ('consulting', 'engineering', 'product', 'general');
create type public.speaker        as enum ('interviewer', 'candidate');

-- Flags a scorer can raise against a transcript line. Extend deliberately:
-- the UI maps each value to a sentence, so a new value needs a new label.
create type public.transcript_flag as enum ('filler', 'restated', 'no_number', 'rambled');

-- ---------------------------------------------------------------------- users
-- Mirrors auth.users. is_guest tracks anonymous sign-ins so guest data can be
-- swept on a schedule, or claimed if the guest later adds an email.

create table public.users (
  id           uuid primary key references auth.users (id) on delete cascade,
  email        text,
  display_name text,
  is_guest     boolean     not null default false,
  created_at   timestamptz not null default now()
);

-- ------------------------------------------------------------------- sessions

create table public.sessions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.users (id) on delete cascade,
  title            text not null,
  track            public.track          not null default 'general',
  status           public.session_status not null default 'draft',
  scheduled_for    timestamptz,
  started_at       timestamptz,
  ended_at         timestamptz,
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  created_at       timestamptz not null default now()
);

-- --------------------------------------------------------------------- rounds

create table public.rounds (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid     not null references public.sessions (id) on delete cascade,
  -- Not "position": POSITION(x IN y) is SQL grammar, and a bare
  -- `position` inside a CHECK is exactly where that ambiguity bites.
  ordinal     smallint not null check (ordinal > 0),
  question    text     not null,
  asked_at    timestamptz,
  answered_at timestamptz,
  created_at  timestamptz not null default now(),
  unique (session_id, ordinal)
);

-- --------------------------------------------------------------------- scores
-- The three sub-scores are fixed columns, not rows, because the design fixes
-- them at three. Adding a fourth should be a deliberate migration rather than
-- something a writer can do by inserting a row.

create table public.scores (
  session_id  uuid primary key references public.sessions (id) on delete cascade,
  overall     smallint not null check (overall     between 0 and 100),
  structure   smallint not null check (structure   between 0 and 100),
  specificity smallint not null check (specificity between 0 and 100),
  pace        smallint not null check (pace        between 0 and 100),
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- transcripts

create table public.transcripts (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid    not null references public.sessions (id) on delete cascade,
  round_id   uuid    references public.rounds (id) on delete cascade,
  at_seconds integer not null check (at_seconds >= 0),
  speaker    public.speaker not null,
  body       text    not null,
  flag       public.transcript_flag,
  created_at timestamptz not null default now()
);

-- -------------------------------------------------------------------- indexes

create index sessions_user_started_idx on public.sessions (user_id, started_at desc nulls last);
create index sessions_user_status_idx  on public.sessions (user_id, status);
create index rounds_session_ord_idx    on public.rounds (session_id, ordinal);
create index transcripts_session_idx   on public.transcripts (session_id, at_seconds);
create index transcripts_flagged_idx   on public.transcripts (session_id) where flag is not null;

-- ------------------------------------------------------------------------ RLS

alter table public.users       enable row level security;
alter table public.sessions    enable row level security;
alter table public.rounds      enable row level security;
alter table public.scores      enable row level security;
alter table public.transcripts enable row level security;

-- users: read and update your own row. Inserts come from the trigger below,
-- so there is deliberately no insert policy.
create policy users_select_own on public.users
  for select using ((select auth.uid()) = id);

create policy users_update_own on public.users
  for update using ((select auth.uid()) = id)
              with check ((select auth.uid()) = id);

create policy sessions_own on public.sessions
  for all using ((select auth.uid()) = user_id)
          with check ((select auth.uid()) = user_id);

-- The child tables inherit ownership through sessions.
create policy rounds_own on public.rounds
  for all using (exists (
        select 1 from public.sessions s
        where s.id = rounds.session_id and s.user_id = (select auth.uid())))
      with check (exists (
        select 1 from public.sessions s
        where s.id = rounds.session_id and s.user_id = (select auth.uid())));

create policy scores_own on public.scores
  for all using (exists (
        select 1 from public.sessions s
        where s.id = scores.session_id and s.user_id = (select auth.uid())))
      with check (exists (
        select 1 from public.sessions s
        where s.id = scores.session_id and s.user_id = (select auth.uid())));

create policy transcripts_own on public.transcripts
  for all using (exists (
        select 1 from public.sessions s
        where s.id = transcripts.session_id and s.user_id = (select auth.uid())))
      with check (exists (
        select 1 from public.sessions s
        where s.id = transcripts.session_id and s.user_id = (select auth.uid())));

-- --------------------------------------------------------- new-user trigger
-- security definer so it can write public.users before any policy applies.
-- search_path is pinned empty, so every name below is fully qualified.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (id, email, is_guest)
  values (new.id, new.email, coalesce(new.is_anonymous, false))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------- flag rollup
-- "What to work on" needs a group-by that PostgREST cannot express, so it
-- lives here. security_invoker keeps the caller's RLS in force, so the view
-- cannot leak another user's flags.

create view public.flag_summary
with (security_invoker = on) as
  select
    s.user_id,
    t.flag,
    count(*)::int                      as flag_count,
    count(distinct t.session_id)::int  as session_count
  from public.transcripts t
  join public.sessions s on s.id = t.session_id
  where t.flag is not null
  group by s.user_id, t.flag;
