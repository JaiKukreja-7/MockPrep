-- ============================================================================
-- Per-user daily LLM caps.
--
-- The cap lives on the user row and the counter in its own table, so a cap
-- change is a data edit rather than a deploy. Guests get a lower cap because
-- an anonymous account costs nothing to create.
-- ============================================================================

alter table public.users
  add column if not exists daily_request_cap smallint not null default 60;

comment on column public.users.daily_request_cap is
  'Max LLM requests per calendar day. Guests default to 10, email users to 60.';

create table if not exists public.llm_usage (
  user_id  uuid not null references public.users (id) on delete cascade,
  day      date not null default current_date,
  requests int  not null default 0 check (requests >= 0),
  primary key (user_id, day)
);

alter table public.llm_usage enable row level security;

-- Readable by its owner so the UI can show what is left. Writes happen only
-- through the function below, which is why there is no insert/update policy.
create policy llm_usage_select_own on public.llm_usage
  for select using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Atomic check-and-increment.
--
-- Returns whether the spend is allowed, and the counters either way. The row
-- is locked before the comparison: without FOR UPDATE, two rounds submitted
-- at once both read the old count and both slip under the cap.
-- ---------------------------------------------------------------------------

create or replace function public.consume_llm_quota(p_cost int default 1)
returns table (allowed boolean, used int, cap int)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_cap  int;
  v_used int;
begin
  if v_user is null then
    return query select false, 0, 0;
    return;
  end if;

  select u.daily_request_cap into v_cap
    from public.users u where u.id = v_user;

  if v_cap is null then
    return query select false, 0, 0;
    return;
  end if;

  insert into public.llm_usage (user_id, day, requests)
  values (v_user, current_date, 0)
  on conflict (user_id, day) do nothing;

  select lu.requests into v_used
    from public.llm_usage lu
   where lu.user_id = v_user and lu.day = current_date
     for update;

  if v_used + p_cost > v_cap then
    return query select false, v_used, v_cap;
    return;
  end if;

  update public.llm_usage
     set requests = requests + p_cost
   where user_id = v_user and day = current_date
  returning requests into v_used;

  return query select true, v_used, v_cap;
end;
$$;

revoke all on function public.consume_llm_quota(int) from public;
grant execute on function public.consume_llm_quota(int) to authenticated, anon;

-- ---------------------------------------------------------------------------
-- Guests get the lower cap at creation.
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_guest boolean := coalesce(new.is_anonymous, false);
begin
  insert into public.users (id, email, is_guest, daily_request_cap)
  values (new.id, new.email, v_guest, case when v_guest then 10 else 60 end)
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Existing guests predate the column default.
update public.users set daily_request_cap = 10
 where is_guest and daily_request_cap = 60;
