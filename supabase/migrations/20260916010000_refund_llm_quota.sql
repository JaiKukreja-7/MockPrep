-- ---------------------------------------------------------------------------
-- refund_llm_quota(): give back a request that was charged for a round that
-- never came to be.
--
-- consume_llm_quota() charges before the questions are generated, because
-- the cap is a spend control on provider calls and a caller at the cap must
-- not be able to trigger generation for free. When generation or the insert
-- then fails, the person has paid for nothing; this returns it. Floored at
-- zero, same row lock as the charge.
-- ---------------------------------------------------------------------------

create or replace function public.refund_llm_quota(p_cost int default 1)
returns table (used int, cap int)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_cap  int;
  v_used int;
begin
  if v_user is null or p_cost <= 0 then
    return query select 0, 0;
    return;
  end if;

  select u.daily_request_cap into v_cap
    from public.users u where u.id = v_user;

  update public.llm_usage
     set requests = greatest(0, requests - p_cost)
   where user_id = v_user and day = current_date
  returning requests into v_used;

  return query select coalesce(v_used, 0), coalesce(v_cap, 0);
end;
$$;

revoke all on function public.refund_llm_quota(int) from public;
grant execute on function public.refund_llm_quota(int) to authenticated, anon;
