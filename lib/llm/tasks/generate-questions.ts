import "server-only";
import { runTask } from "../index";
import { parseJson } from "../json";
import type { Track } from "@/lib/supabase/types";

const TRACK_BRIEF: Record<Track, string> = {
  consulting: "management consulting case and behavioural interviews",
  engineering: "software engineering behavioural and system design interviews",
  product: "product management interviews",
  general: "general graduate job interviews",
};

export interface GenerateQuestionsInput {
  track: Track;
  role: string;
  count: number;
}

/**
 * Questions carry no user content — only a track and a role — which is why
 * this task is not marked sensitive and can use the Gemini free tier.
 */
export async function generateQuestions({
  track,
  role,
  count,
}: GenerateQuestionsInput): Promise<{ questions: string[]; provider: string }> {
  const result = await runTask("question_generation", {
    json: true,
    temperature: 0.8,
    system:
      "You write interview questions for a mock interview trainer. " +
      "Return only JSON. No commentary, no markdown fences.",
    user:
      `Write ${count} interview questions for a candidate interviewing for ` +
      `"${role}" in the context of ${TRACK_BRIEF[track]}.\n\n` +
      `Rules:\n` +
      `- Each question is one sentence a real interviewer would say aloud.\n` +
      `- Sentence case. No numbering, no preamble.\n` +
      `- Vary them: do not ask the same competency twice.\n\n` +
      `Return exactly this shape:\n` +
      `{"questions": ["...", "..."]}`,
  });

  const parsed = parseJson<{ questions?: unknown }>(result.text);
  const questions = Array.isArray(parsed.questions)
    ? parsed.questions
        .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
        .map((q) => q.trim())
        .slice(0, count)
    : [];

  if (questions.length === 0) {
    throw new Error("Question generation returned no usable questions.");
  }

  return { questions, provider: `${result.provider}/${result.model}` };
}
