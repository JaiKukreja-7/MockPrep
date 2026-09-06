import "server-only";
import { runTask } from "../index";
import { parseJson } from "../json";

export interface ScoreAnswerInput {
  question: string;
  answer: string;
}

export interface AnswerScore {
  structure: number;
  specificity: number;
  pace: number;
  /** Derived here, not asked of the model — see below. */
  overall: number;
  note: string;
  provider: string;
}

const clamp = (n: unknown): number => {
  const value = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
};

export async function scoreAnswer({
  question,
  answer,
}: ScoreAnswerInput): Promise<AnswerScore> {
  const result = await runTask("answer_scoring", {
    json: true,
    temperature: 0.2,
    system:
      "You score mock interview answers. You are specific and unsentimental. " +
      "Return only JSON. No commentary, no markdown fences.",
    user:
      `Score this answer out of 100 on three axes.\n\n` +
      `structure — does it open with a claim, carry a shape (situation, ` +
      `action, result), and land?\n` +
      `specificity — named things, numbers, concrete outcomes, versus vague ` +
      `generalities.\n` +
      `pace — is it the right length, or does it stall, ramble, or stop short?\n\n` +
      `QUESTION:\n${question}\n\nANSWER:\n${answer}\n\n` +
      `Also write one sentence, addressed to the candidate, naming the single ` +
      `biggest thing to fix. Sentence case.\n\n` +
      `Return exactly this shape:\n` +
      `{"structure": 0, "specificity": 0, "pace": 0, "note": "..."}`,
  });

  const parsed = parseJson<Record<string, unknown>>(result.text);

  const structure = clamp(parsed.structure);
  const specificity = clamp(parsed.specificity);
  const pace = clamp(parsed.pace);

  return {
    structure,
    specificity,
    pace,
    // Computed here rather than asked of the model: an overall the model
    // invents separately can contradict its own sub-scores, and the design
    // leans on rank, so the number has to follow from what is displayed.
    overall: Math.round((structure + specificity + pace) / 3),
    note: typeof parsed.note === "string" ? parsed.note : "",
    provider: `${result.provider}/${result.model}`,
  };
}
