import "server-only";
import { runTask } from "../index";
import { redactContactDetails } from "@/lib/resume/redact";
import {
  buildQuestionPrompt,
  parseQuestions,
  planTailoredRound,
  type GeneratedQuestion,
  type GenerateQuestionsInput,
  type Tailoring,
} from "./generate-questions";

/**
 * Questions written against a resume and/or a job.
 *
 * Routed to `tailored_question_generation`, marked sensitive — see
 * lib/llm/routing.ts, where the route table refuses at import to send it
 * anywhere that may train on submitted content. The resume text arrives
 * here from the caller's memory and leaves only inside the prompt; what
 * comes back is questions, and even those are contact-redacted before they
 * are returned to anything that could store them, in case the model quoted
 * an email or a URL off the page.
 */
export async function generateTailoredQuestions({
  track,
  role,
  level,
  tailoring,
  focus,
  random = Math.random,
}: GenerateQuestionsInput & { tailoring: Tailoring }): Promise<{ questions: GeneratedQuestion[]; provider: string }> {
  const plan = planTailoredRound(track, level, tailoring, random);
  const prompt = buildQuestionPrompt({ track, role, level, plan, tailoring, focus });

  const result = await runTask("tailored_question_generation", {
    json: true,
    temperature: 0.7,
    ...prompt,
  });

  const questions = parseQuestions(result.text, plan, track).map((q) => ({
    ...q,
    question: redactContactDetails(q.question),
    topic: q.topic ? redactContactDetails(q.topic) : null,
  }));
  return { questions, provider: `${result.provider}/${result.model}` };
}
