-- ---------------------------------------------------------------------------
-- delete_own_guest(): a guest removes their own account, and only their own.
--
-- Two callers. The integration tests sign in anonymously to prove the quota
-- function and the column grants, and a test suite that leaves a row behind
-- on every run is a test suite nobody keeps running. And a guest who tried a
-- round and wants nothing kept should be able to say so.
--
-- SECURITY DEFINER because auth.users is not writable by the caller; the
-- function's own checks are the whole guard: the row must be the caller's,
-- and it must be anonymous. An email account is never deleted here — that
-- goes through Supabase's own flow. Everything the guest owned goes with the
-- row: public.users, sessions, rounds, transcripts, scores, llm_usage and
-- analyses all cascade from auth.users.
-- ---------------------------------------------------------------------------

create or replace function public.delete_own_guest()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_anon boolean;
begin
  if v_user is null then
    return false;
  end if;

  select u.is_anonymous into v_anon
    from auth.users u
   where u.id = v_user;

  if not coalesce(v_anon, false) then
    return false;
  end if;

  delete from auth.users where id = v_user;
  return true;
end;
$$;

revoke all on function public.delete_own_guest() from public;
-- Anonymous sessions carry the authenticated role with is_anonymous set.
grant execute on function public.delete_own_guest() to authenticated;
