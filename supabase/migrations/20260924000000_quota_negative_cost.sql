-- ---------------------------------------------------------------------------
-- consume_llm_quota(): refuse a non-positive cost.
--
-- Without this, a caller at the cap could spend a NEGATIVE number of requests
-- and walk the counter back down — the check `v_used + p_cost > v_cap` passes
-- trivially for a negative cost, and the update then subtracts. Ten spends,
-- one call with p_cost => -10, and the cap is fresh again; repeat forever.
-- The publishable key is in the browser by design, so this was reachable by
-- anyone, including a guest, with one RPC call.
--
-- refund_llm_quota() has had exactly this guard since it was written
-- (`if v_user is null or p_cost <= 0`); it was never added to the charge.
-- Refunds stay the only way the counter goes down, and they floor at zero.
--
-- Everything else about the function is unchanged: same lock discipline,
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
  -- A cost of zero or less is never a spend. Returning "not allowed" rather
  -- than raising keeps the shape a caller already handles.
  if v_user is null or p_cost <= 0 then
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
