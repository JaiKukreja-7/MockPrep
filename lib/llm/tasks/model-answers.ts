import "server-only";
import { runTask } from "../index";
import { parseJson } from "../json";
import {
  modelAnswerInstruction,
  sanitiseModelAnswer,
  type RoundToScore,
} from "./score-answer";

/**
 * Model answers as a call of their own.
 *
 * MEASUREMENT ONLY — nothing in the app calls this. It exists so
 * tests/integration/model-answer-route.test.ts can compare the two routes
 * against real providers, and as the ready-made fallback if folding them
 * into the scoring call ever stops being reliable. To adopt it, call it from
 * scoreSession instead of passing `withModelAnswers` to scoreRounds. The
 * instruction itself lives in score-answer.ts and is shared, so the two
 * routes cannot drift.
 *
 * Not sensitive, and on the same chain as scoring: the inputs are exactly
 * what scoring already sees — the question (stored, and contact-redacted at
 * write time for a tailored round) and the candidate's own answer. No
 * resume text reaches this, or scoring.
 *
 * See PROGRESS.md for the measurement that chose folded over separate.
 */
export async function modelAnswers(
  rounds: RoundToScore[],
  sensitive = false,
): Promise<{
  answers: Map<number, string>;
  provider: string;
}> {
  const exchange = rounds
    .map(
      (r) =>
        `### Question ${r.ordinal} — type ${r.type}${r.topic ? ` (${r.topic})` : ""}, asked at the "${r.level}" level\n` +
        `Q: ${r.question}\n` +
        `A: ${r.answer}` +
        (r.followUp ? `\nFollow-up: ${r.followUp}\nA: ${r.followUpAnswer ?? "(no answer)"}` : ""),
    )
    .join("\n\n");

  const result = await runTask("answer_scoring", {
    json: true,
    temperature: 0.2,
    sensitive,
    system:
      "You are an interview coach showing a candidate what a strong answer " +
      "sounds like. You are specific and unsentimental, and you never " +
      "flatter. Return only JSON. No commentary, no markdown fences.",
    user:
      `${exchange}\n\n` +
      modelAnswerInstruction(rounds) +
      `Return exactly this shape:\n` +
      `{"rounds": [${rounds.map((r) => `{"ordinal": ${r.ordinal}, "model_answer": "..."}`).join(", ")}]}`,
  });

  const parsed = parseJson<{ rounds?: unknown }>(result.text);
  const answers = new Map<number, string>();
  if (Array.isArray(parsed.rounds)) {
    for (const entry of parsed.rounds) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Record<string, unknown>;
      const ordinal = Number(e.ordinal);
      const answer = sanitiseModelAnswer(e.model_answer);
      if (Number.isInteger(ordinal) && answer) answers.set(ordinal, answer);
    }
  }
  return { answers, provider: `${result.provider}/${result.model}` };
}
