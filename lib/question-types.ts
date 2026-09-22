import type { QuestionSource, QuestionType } from "@/lib/supabase/types";

/** Screen labels for question types. Sentence case; the eyebrow uppercases. */
export const TYPE_LABEL: Record<QuestionType, string> = {
  behavioural: "Behavioural",
  case: "Case",
  product_sense: "Product sense",
  dsa: "DSA",
  cs_fundamentals: "CS fundamentals",
  system_design: "System design",
};

/** Screen labels for where a tailored question came from. */
export const SOURCE_LABEL: Record<QuestionSource, string> = {
  resume: "From your resume",
  job: "From the job",
  gap: "Gap",
};
