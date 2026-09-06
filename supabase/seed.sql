-- Local development only. Seeds one scored session with a flagged transcript
-- for the most recently created user, so the dashboard has something to read.
-- Sign in once first, then run this file.

do $$
declare
  target_user uuid;
  scored_id   uuid;
  round_id    uuid;
begin
  select id into target_user from auth.users order by created_at desc limit 1;

  if target_user is null then
    raise notice 'No users yet — sign in once, then re-run this file.';
    return;
  end if;

  -- A scored session, its round, its score and a flagged transcript.
  insert into public.sessions (user_id, title, track, status, started_at, ended_at, duration_seconds)
  values (target_user, 'Behavioural round 3', 'consulting', 'scored',
          now() - interval '3 days', now() - interval '3 days' + interval '18 minutes', 1122)
  returning id into scored_id;

  insert into public.rounds (session_id, ordinal, question)
  values (scored_id, 1, 'Tell me about a time you disagreed with your manager.')
  returning id into round_id;

  insert into public.scores (session_id, overall, structure, specificity, pace)
  values (scored_id, 74, 81, 62, 54);

  insert into public.transcripts (session_id, round_id, at_seconds, speaker, body, flag) values
    (scored_id, round_id,   4, 'interviewer', 'Tell me about a time you disagreed with your manager.', null),
    (scored_id, round_id,  11, 'candidate',   'So, um, there was this thing last year, I guess.',      'filler'),
    (scored_id, round_id,  19, 'candidate',   'Sorry — so the question was about disagreeing.',        'restated'),
    (scored_id, round_id,  76, 'candidate',   'We split the release and it shipped a lot faster.',     'no_number');

  -- A couple more scored rounds so the list has depth.
  insert into public.sessions (user_id, title, track, status, started_at, ended_at, duration_seconds)
  values (target_user, 'Case study drill', 'consulting', 'scored',
          now() - interval '6 days', now() - interval '6 days' + interval '26 minutes', 1570)
  returning id into scored_id;
  insert into public.scores (session_id, overall, structure, specificity, pace)
  values (scored_id, 68, 70, 61, 58);

  insert into public.sessions (user_id, title, track, status, started_at, ended_at, duration_seconds)
  values (target_user, 'Technical screen', 'engineering', 'scored',
          now() - interval '12 days', now() - interval '12 days' + interval '41 minutes', 2490)
  returning id into scored_id;
  insert into public.scores (session_id, overall, structure, specificity, pace)
  values (scored_id, 55, 60, 49, 52);

  -- One scheduled round, for "Up next".
  insert into public.sessions (user_id, title, track, status, scheduled_for)
  values (target_user, 'System design', 'engineering', 'draft', now() + interval '2 days');

  raise notice 'Seeded demo data for user %', target_user;
end $$;
