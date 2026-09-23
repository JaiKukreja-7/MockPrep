-- ---------------------------------------------------------------------------
-- Model answers: what a strong answer to each question would have been.
--
-- Written once, with the round's score, in the same update — a report never
-- shows a score without its lesson, or a lesson without its score. Generated
-- from the question, its type, the level and the candidate's own answer, so
-- it addresses what they missed rather than reciting an ideal. Null on rounds
-- scored before this existed, and on any round where the model did not
-- return a usable one; the report simply omits the row then.
-- ---------------------------------------------------------------------------

alter table public.rounds
  add column model_answer text;

comment on column public.rounds.model_answer is
  'What a strong answer would have been, written against this candidate''s answer. Generated once at scoring time.';
