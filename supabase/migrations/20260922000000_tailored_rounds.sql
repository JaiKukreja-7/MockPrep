-- ---------------------------------------------------------------------------
-- Tailored rounds: questions written against a resume and/or a job.
--
-- The job details are the user's target, not their history, so they live on
-- the session. The resume never does: it is parsed in memory, sent to the
-- one private-policy provider, and dropped. What persists from it is a flag
-- saying the round was tailored from one, and the questions it produced —
-- which are contact-redacted at write time like every other stored excerpt.
--
-- Each round records where its question came from, so the live screen and
-- the report can say "from your resume" or "gap" next to the type.
-- ---------------------------------------------------------------------------

alter table public.sessions
  add column job_title text,
  add column company text,
  add column job_description text,
  add column tailored_from_resume boolean not null default false;

comment on column public.sessions.tailored_from_resume is
  'The round''s questions were written against an uploaded resume. The resume itself is never stored.';

-- 'job' — written to a stated requirement; 'resume' — probes a project,
-- stack or claim on the resume; 'gap' — a requirement the resume does not
-- evidence. Null — the track's standard plan.
create type public.question_source as enum ('resume', 'job', 'gap');

alter table public.rounds
  add column source public.question_source;

-- ---------------------------------------------------------------------------
-- A resume requires an account — enforced in the database, same shape as
-- rounds_voice_requires_account: RESTRICTIVE, so it narrows the permissive
-- sessions_own policy instead of widening it.
-- ---------------------------------------------------------------------------

create policy sessions_resume_requires_account on public.sessions
  as restrictive
  for all
  using (
    tailored_from_resume = false
    or exists (
      select 1 from public.users u
       where u.id = (select auth.uid()) and u.is_guest = false
    )
  )
  with check (
    tailored_from_resume = false
    or exists (
      select 1 from public.users u
       where u.id = (select auth.uid()) and u.is_guest = false
    )
  );
