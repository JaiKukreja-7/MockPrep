-- ============================================================================
-- Voice mode.
--
--   rounds.mode                 text | voice
--   transcripts.start_ms/end_ms word-level span within the round
--   llm_usage.voice_seconds     voice metered alongside request counts
--   users.daily_voice_sec_cap   0 for guests — voice needs a real account
--
-- transcripts.speaker already exists from the initial migration
-- (enum public.speaker: interviewer | candidate) and is unchanged.
-- ============================================================================

create type public.round_mode as enum ('text', 'voice');

alter table public.rounds
  add column if not exists mode public.round_mode not null default 'text';

-- Millisecond spans. at_seconds stays as the coarse ordering key the text
-- transcript already uses; these carry the precise span voice needs for
-- playback alignment and barge-in bookkeeping.
alter table public.transcripts
  add column if not exists start_ms integer check (start_ms is null or start_ms >= 0),
  add column if not exists end_ms   integer check (end_ms   is null or end_ms   >= 0);

alter table public.transcripts
  add constraint transcripts_span_ordered
  check (start_ms is null or end_ms is null or end_ms >= start_ms);

-- ---------------------------------------------------------------------------
-- Voice budget, alongside the existing request counter.
-- ---------------------------------------------------------------------------

alter table public.llm_usage
  add column if not exists voice_seconds int not null default 0
    check (voice_seconds >= 0);

alter table public.users
  add column if not exists daily_voice_sec_cap int not null default 1800;

comment on column public.users.daily_voice_sec_cap is
  'Daily voice seconds. 0 for guests: voice requires a real account.';

update public.users set daily_voice_sec_cap = 0 where is_guest;

-- Guests get no voice budget at creation.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_guest boolean := coalesce(new.is_anonymous, false);
begin
  insert into public.users (id, email, is_guest, daily_request_cap, daily_voice_sec_cap)
  values (
    new.id, new.email, v_guest,
    case when v_guest then 10 else 60 end,
    case when v_guest then 0 else 1800 end
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Voice requires an account — enforced in the database, not just the UI.
--
-- RESTRICTIVE, deliberately: the existing rounds_own policy is permissive,
-- and permissive policies are OR-ed together, so a second permissive policy
-- would widen access rather than narrow it. Restrictive policies are AND-ed,
-- so this genuinely blocks a guest from writing a voice round even if they
-- drive the API directly.
-- ---------------------------------------------------------------------------

create policy rounds_voice_requires_account on public.rounds
  as restrictive
  for all
  using (
    mode <> 'voice'
    or exists (
      select 1 from public.users u
       where u.id = (select auth.uid()) and u.is_guest = false
    )
  )
  with check (
    mode <> 'voice'
    or exists (
      select 1 from public.users u
       where u.id = (select auth.uid()) and u.is_guest = false
    )
  );

-- ---------------------------------------------------------------------------
-- Atomic voice metering. Same locking discipline as consume_llm_quota:
-- read under FOR UPDATE, or two concurrent streams both slip under the cap.
--
-- Returns the seconds actually granted, which may be fewer than requested —
-- the caller uses that to cut a stream off mid-round rather than refusing it
-- outright.
-- ---------------------------------------------------------------------------

create or replace function public.consume_voice_seconds(p_seconds int)
returns table (allowed boolean, granted int, used int, cap int)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user  uuid := (select auth.uid());
  v_cap   int;
  v_used  int;
  v_grant int;
begin
  if v_user is null or p_seconds < 0 then
    return query select false, 0, 0, 0;
    return;
  end if;

  select u.daily_voice_sec_cap into v_cap
    from public.users u where u.id = v_user;

  if v_cap is null or v_cap = 0 then
    -- Guests land here: no account, no voice.
    return query select false, 0, 0, coalesce(v_cap, 0);
    return;
  end if;

  insert into public.llm_usage (user_id, day, requests, voice_seconds)
  values (v_user, current_date, 0, 0)
  on conflict (user_id, day) do nothing;

  select lu.voice_seconds into v_used
    from public.llm_usage lu
   where lu.user_id = v_user and lu.day = current_date
     for update;

  v_grant := least(p_seconds, greatest(v_cap - v_used, 0));

  if v_grant = 0 then
    return query select false, 0, v_used, v_cap;
    return;
  end if;

  update public.llm_usage
     set voice_seconds = voice_seconds + v_grant
   where user_id = v_user and day = current_date
  returning voice_seconds into v_used;

  return query select true, v_grant, v_used, v_cap;
end;
$$;

revoke all on function public.consume_voice_seconds(int) from public;
grant execute on function public.consume_voice_seconds(int) to authenticated;

-- ---------------------------------------------------------------------------
-- Column-level lockdown on public.users.
--
-- users_update_own (from the initial migration) checks WHICH ROW you may
-- update, but RLS cannot restrict WHICH COLUMNS. With the default table-wide
-- UPDATE grant, a signed-in user could therefore set is_guest = false on
-- themselves to unlock voice, or raise their own daily_request_cap. Both are
-- reachable straight from the anon key with a user JWT.
--
-- Column grants are the missing half: the policy picks the row, the grant
-- picks the columns. Everything privileged is left to SECURITY DEFINER
-- functions and the signup trigger, which run as the definer and are
-- unaffected by this.
-- ---------------------------------------------------------------------------

revoke update on public.users from authenticated, anon;
grant update (display_name) on public.users to authenticated;
