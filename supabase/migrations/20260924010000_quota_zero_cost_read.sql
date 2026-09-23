-- ---------------------------------------------------------------------------
-- consume_llm_quota(): block a NEGATIVE cost only, not a zero one.
--
-- 20260924000000 closed the cap bypass by refusing `p_cost <= 0`. That was
-- wider than the bug: a cost of zero cannot decrement anything, and it was
-- already in use as a read of the counter — `consume(0)` returns the day's
-- usage and the cap without spending, which is how the integration suite
-- checks a new guest starts at 0 of 10. The wider guard made that return
-- {false, 0, 0} and lost the numbers.
--
-- So: `p_cost < 0` is refused (the actual hole — a negative cost passed the
-- `used + cost > cap` check and the update then subtracted), and zero goes
-- down the normal path, where `requests + 0` changes nothing.
--
-- Everything else is unchanged from 20260924000000: same lock discipline,
-- same return shape, same grants.
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
  -- Negative only. Refunds are the one way the counter goes down, and they
  -- floor at zero; see refund_llm_quota.
  if v_user is null or p_cost < 0 then
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
