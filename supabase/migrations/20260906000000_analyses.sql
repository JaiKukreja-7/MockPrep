-- ============================================================================
-- Resume analyses.
--
-- WHAT IS DELIBERATELY NOT HERE: a column for the resume text.
--
-- The upload is parsed in memory, sent to the analyser, and dropped. What
-- persists is the verdict — scores, keyword lists, and findings. Findings may
-- carry a short excerpt, because a finding that cannot point at the line it
-- is about is useless, but the application truncates those to 160 characters
-- and caps the number of findings, so the row can never accumulate into a
-- copy of the document. `source_chars` records the length only.
--
-- SECOND POLICY: excerpts carry no contact details.
--
-- Phone numbers, email addresses and URLs are replaced with [phone], [email]
-- and [url] before the row is built — at write time, in
-- lib/resume/redact.ts, not when the finding is rendered. Redacting on
-- display would leave the real value sitting in this table, which is the
-- thing being avoided. The analyser is separately told to describe a contact
-- formatting problem rather than quote it, so the redactor is a backstop
-- rather than the first line.
--
-- Anything added here that stores more of the document, or that widens what
-- an excerpt may contain, is a change of policy, not a schema tweak.
-- ============================================================================

create type public.analysis_kind as enum ('resume');

create table public.analyses (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users (id) on delete cascade,
  kind          public.analysis_kind not null default 'resume',

  target_role   text not null,
  source_name   text not null,
  source_kind   text not null check (source_kind in ('pdf', 'docx')),
  source_chars  integer not null default 0 check (source_chars >= 0),

  ats_score        smallint not null check (ats_score        between 0 and 100),
  parseability     smallint not null check (parseability     between 0 and 100),
  keyword_coverage smallint not null check (keyword_coverage between 0 and 100),
  formatting       smallint not null check (formatting       between 0 and 100),
  bullet_strength  smallint not null check (bullet_strength  between 0 and 100),

  -- { "matched": [...], "missing": [...] }
  keywords  jsonb not null default '{"matched": [], "missing": []}'::jsonb,
  -- [ { category, title, detail, excerpt } ]
  findings  jsonb not null default '[]'::jsonb,

  created_at timestamptz not null default now()
);

create index analyses_user_created_idx
  on public.analyses (user_id, created_at desc);

-- ---------------------------------------------------------------------------- RLS

alter table public.analyses enable row level security;

create policy analyses_own on public.analyses
  for all using ((select auth.uid()) = user_id)
          with check ((select auth.uid()) = user_id);

-- Uploads need a real account, for the same reason voice does: a resume is
-- the most identifying thing a user will hand over, and an anonymous session
-- has no way to come back and delete it.
--
-- RESTRICTIVE, deliberately: analyses_own above is permissive, and permissive
-- policies are OR-ed together, so a second permissive policy would widen
-- access rather than narrow it. Restrictive policies are AND-ed.
create policy analyses_require_account on public.analyses
  as restrictive
  for all
  using (
    exists (
      select 1 from public.users u
       where u.id = (select auth.uid()) and u.is_guest = false
    )
  )
  with check (
    exists (
      select 1 from public.users u
       where u.id = (select auth.uid()) and u.is_guest = false
    )
  );
