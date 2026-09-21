-- ---------------------------------------------------------------------------
-- Question types, experience level, follow-ups, per-round scores.
--
-- The engineering track was producing generic behavioural questions. Rounds
-- now carry what kind of question each is, sessions carry the level the
-- questions were pitched at, a round may hold the one probing follow-up the
-- interviewer asked, and each round gets its own score under a rubric that
-- fits its type — so a report can say "DSA: approach 70, complexity 40" and
-- the dashboard can break scores down by type.
-- ---------------------------------------------------------------------------

create type public.question_type as enum (
  'behavioural', 'case', 'product_sense', 'dsa', 'cs_fundamentals', 'system_design'
);

-- 'junior' is the 1–3 years band. Named for the column, labelled on screen.
create type public.experience_level as enum ('intern', 'fresher', 'junior');

alter table public.sessions
  add column level public.experience_level not null default 'fresher';

alter table public.rounds
  add column question_type public.question_type not null default 'behavioural',
  -- e.g. "two pointers", "DBMS indexing". Free text from the generator.
  add column topic text,
  -- The one probing follow-up asked after a weak answer. Null means none was
  -- asked; non-null means the cap of one is spent, whatever the answer was.
  add column follow_up text,
  -- Per-round content score under the type's rubric, 0–100, derived from the
  -- rubric axes in score_detail. Null until the session is scored.
  add column score smallint check (score between 0 and 100),
  add column score_detail jsonb;

comment on column public.rounds.follow_up is
  'The single probing follow-up for this round. Non-null spends the cap of one.';
