import "server-only";
import { runTask } from "../index";
import { parseJson } from "../json";
import type { ExperienceLevel, QuestionType } from "@/lib/supabase/types";

export interface FollowUpInput {
  type: QuestionType;
  level: ExperienceLevel;
  question: string;
  answer: string;
  /**
   * True when the round was tailored to a resume: the question names the
   * candidate's own projects, so this call may not reach a provider that
   * trains on what it is sent.
   */
  sensitive?: boolean;
}

/** What a gap in each kind of answer looks like — the thing to probe for. */
const GAPS: Record<QuestionType, string> = {
  dsa:
    "no stated time or space complexity, a brute force with no better idea, " +
    "an unhandled edge case (empty input, duplicates, negative numbers, a " +
    "single element), or an approach described so vaguely it could not be coded",
  cs_fundamentals:
    "a definition with no 'why', a wrong or missing mechanism, or an answer " +
    "that never reaches what actually happens",
  system_design:
    "components named with no data flow between them, no trade-off " +
    "considered, no thought about what happens under load or failure",
  behavioural: "no concrete situation, no action the candidate personally took, no result",
  case: "no structure, no numbers, a recommendation with no reasoning",
  product_sense: "no user named, no success metric, a feature with no reason",
};

/** Exported so its structure can be asserted without a model. */
export function buildFollowUpPrompt({ type, level, question, answer }: FollowUpInput) {
  return {
    system:
      "You are the interviewer in a mock interview, deciding whether to ask " +
      "ONE probing follow-up before moving on. Return only JSON. No " +
      "commentary, no markdown fences.",
    user:
      `The candidate is at the "${level}" level. You asked a ${type.replace("_", " ")} question:\n` +
      `${question}\n\n` +
      `They answered:\n${answer}\n\n` +
      `A follow-up is warranted ONLY if the answer is weak or vague — for this ` +
      `kind of question that means: ${GAPS[type]}. A solid answer gets no ` +
      `follow-up.\n\n` +
      `If warranted, write the single question you would ask aloud, aimed at ` +
      `the specific gap — for example "What is the time complexity of that?" ` +
      `or "What happens if the input is empty?" — at most 25 words, one ` +
      `question mark. If not warranted, return null.\n\n` +
      `Return exactly this shape:\n` +
      `{"probe": "..." }  or  {"probe": null}`,
  };
}

/**
 * Decides whether to probe, and with what. One per question: the caller
 * enforces the cap by never calling this for a round that already has a
 * follow-up stored, so this function is stateless on purpose.
 */
export async function followUp(input: FollowUpInput): Promise<{ probe: string | null; provider: string }> {
  const result = await runTask("follow_up", {
    json: true,
    temperature: 0.3,
    sensitive: input.sensitive,
    ...buildFollowUpPrompt(input),
  });

  const parsed = parseJson<{ probe?: unknown }>(result.text);
  return { probe: sanitiseProbe(parsed.probe), provider: `${result.provider}/${result.model}` };
}

/**
 * The model is asked for one short question; this holds it to that. Anything
 * that is not a string, is empty, or runs past the first question mark is
 * cut back to one question or dropped.
 */
export function sanitiseProbe(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let text = raw.trim().replace(/^["'“]|["'”]$/g, "").trim();
  if (!text || /^(null|none|no)$/i.test(text)) return null;
  const firstQuestion = text.indexOf("?");
  if (firstQuestion !== -1) text = text.slice(0, firstQuestion + 1);
  if (text.length > 220) return null;
  return text;
}
