import type { QuestionType } from "@/lib/supabase/types";

/**
 * What each kind of answer is judged on, in order.
 *
 * This lives here rather than beside the scoring prompt because it is a
 * domain fact that two sides need: the prompt asks for exactly these axes,
 * and the report and the question bank render them. Neither screen should
 * have to import the LLM layer to find out what order to print — and the
 * stored object cannot say, because Postgres returns jsonb keys sorted by
 * length ("depth · clarity · accuracy" rather than the rubric's own order).
 */
export const RUBRIC: Record<QuestionType, readonly string[]> = {
  dsa: ["approach", "complexity", "edge_cases"],
  cs_fundamentals: ["accuracy", "depth", "clarity"],
  system_design: ["requirements", "tradeoffs", "scalability"],
  behavioural: ["situation", "action", "result"],
  case: ["structure", "numbers", "recommendation"],
  product_sense: ["user", "metric", "reasoning"],
};

/** Screen labels for the axes above. */
export const RUBRIC_LABEL: Record<string, string> = {
  approach: "Approach",
  complexity: "Complexity",
  edge_cases: "Edge cases",
  accuracy: "Accuracy",
  depth: "Depth",
  clarity: "Clarity",
  requirements: "Requirements",
  tradeoffs: "Trade-offs",
  scalability: "Scalability",
  situation: "Situation",
  action: "Action",
  result: "Result",
  structure: "Structure",
  numbers: "Numbers",
  recommendation: "Recommendation",
  user: "User",
  metric: "Metric",
  reasoning: "Reasoning",
};
