import "server-only";
import { runTask } from "../index";
import { parseJson } from "../json";
import type { ExperienceLevel, QuestionType } from "@/lib/supabase/types";

/**
 * What each kind of answer is judged on. The session-level delivery axes —
 * structure, specificity, pace — stay as they were and stay on the report's
 * three meters; these are the *content* axes, per round, under the rubric
 * that fits the question. A DSA answer is not "structured" or not; it has or
 * has not got an approach, a complexity and its edge cases.
 */
export const RUBRIC: Record<QuestionType, readonly string[]> = {
  dsa: ["approach", "complexity", "edge_cases"],
  cs_fundamentals: ["accuracy", "depth", "clarity"],
  system_design: ["requirements", "tradeoffs", "scalability"],
  behavioural: ["situation", "action", "result"],
  case: ["structure", "numbers", "recommendation"],
  product_sense: ["user", "metric", "reasoning"],
};

const RUBRIC_GUIDE: Record<QuestionType, string> = {
  dsa:
    "approach — is there a correct, codeable method and is it better than " +
    "brute force where one exists; complexity — did they state time and " +
    "space and get them right; edge_cases — empty input, one element, " +
    "duplicates, overflow, whatever this problem actually has.",
  cs_fundamentals:
    "accuracy — is it right; depth — did they reach the mechanism and the " +
    "why, not the definition; clarity — could a peer follow it.",
  system_design:
    "requirements — did they pin down what the system must do and at what " +
    "scale before designing; tradeoffs — did they choose between options " +
    "and say why; scalability — does the design survive load and failure.",
  behavioural:
    "situation — a specific, real one; action — what they personally did; " +
    "result — an outcome, ideally with a number.",
  case:
    "structure — a framework applied, not recited; numbers — estimated and " +
    "used; recommendation — a decision with reasoning.",
  product_sense:
    "user — a named user with a real need; metric — how success would be " +
    "measured; reasoning — why this and not the alternatives.",
};

export interface RoundToScore {
  ordinal: number;
  type: QuestionType;
  topic: string | null;
  /** Pitches the model answer at the candidate, not at a senior engineer. */
  level: ExperienceLevel;
  question: string;
  answer: string;
  /** The probing follow-up, if one was asked, and what they said to it. */
  followUp: string | null;
  followUpAnswer: string | null;
}

export interface RoundScore {
  ordinal: number;
  /** Mean of the rubric axes — derived here, never asked of the model. */
  score: number;
  detail: Record<string, number>;
  /** What a strong answer would have been. Null when it did not come back. */
  modelAnswer: string | null;
}

export interface SessionScore {
  structure: number;
  specificity: number;
  pace: number;
  /** Derived here, not asked of the model — see below. */
  overall: number;
  note: string;
  rounds: RoundScore[];
  provider: string;
}

const clamp = (n: unknown): number => {
  const value = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
};

/**
 * How long a model answer may be. It is a lesson, not an essay: long enough
 * for an approach, its complexity and its edge cases, short enough to read
 * under a score. Enforced here, after the model, not only asked for.
 */
export const MAX_MODEL_ANSWER_CHARS = 900;

/** Exported so the prompt's structure can be asserted without a model. */
export function buildScoringPrompt(rounds: RoundToScore[], withModelAnswers = true) {
  const exchange = rounds
    .map((r) => {
      const head = `### Question ${r.ordinal} — type ${r.type}${r.topic ? ` (${r.topic})` : ""}, asked at the "${r.level}" level`;
      const lines = [`Q: ${r.question}`, `A: ${r.answer}`];
      if (r.followUp) lines.push(`Follow-up: ${r.followUp}`, `A: ${r.followUpAnswer ?? "(no answer)"}`);
      return `${head}\nRubric: ${RUBRIC_GUIDE[r.type]}\n${lines.join("\n")}`;
    })
    .join("\n\n");

  const shape = rounds
    .map(
      (r) =>
        `{"ordinal": ${r.ordinal}, "detail": {${RUBRIC[r.type].map((k) => `"${k}": 0`).join(", ")}}` +
        (withModelAnswers ? `, "model_answer": "..."` : "") +
        `}`,
    )
    .join(", ");

  return {
    system:
      "You score mock interview answers. You are specific and unsentimental. " +
      "Return only JSON. No commentary, no markdown fences.",
    user:
      `Score this mock interview round.\n\n` +
      `First, the whole round's delivery, each out of 100:\n` +
      `structure — does each answer open with a claim, carry a shape, and land?\n` +
      `specificity — named things, numbers, concrete outcomes, versus vague generalities.\n` +
      `pace — the right length, or does it stall, ramble, or stop short?\n\n` +
      `Then each question on its own rubric, each axis out of 100. Judge the ` +
      `content against the rubric given with the question, and count the ` +
      `follow-up answer where there is one.\n\n` +
      `${exchange}\n\n` +
      (withModelAnswers ? modelAnswerInstruction(rounds) : "") +
      `Also write one sentence, addressed to the candidate, naming the single ` +
      `biggest thing to fix across the round. Sentence case.\n\n` +
      `Return exactly this shape:\n` +
      `{"structure": 0, "specificity": 0, "pace": 0, "note": "...", "rounds": [${shape}]}`,
  };
}

/**
 * The model-answer instruction. Shared by the folded scoring prompt and the
 * standalone task so the two cannot drift: whichever route is taken, the
 * answer on the report was asked for in the same words.
 *
 * It is written against THIS candidate's answer rather than as a model ideal
 * — an answer that silently supplies what they already said teaches nothing.
 */
export function modelAnswerInstruction(rounds: RoundToScore[]): string {
  const axes = [...new Set(rounds.map((r) => r.type))]
    .map((type) => `  ${type}: ${RUBRIC[type].join(", ")}`)
    .join("\n");
  return (
    `For each question also write model_answer: what a strong answer from ` +
    `this candidate would have sounded like, in the first person, as they ` +
    `would say it aloud.\n` +
    `- Cover that question type's rubric axes and nothing else:\n${axes}\n` +
    `- Pitch it at their level. A stronger answer, not a senior engineer's.\n` +
    `- Build on what they actually said: keep what was right, and make the ` +
    `part they missed the part that stands out. Where the question is about ` +
    `their own experience — a project, a claim, something on their resume — ` +
    `use the specifics they gave rather than inventing a different project.\n` +
    `- One short paragraph, or two or three labelled lines. Under ` +
    `${MAX_MODEL_ANSWER_CHARS} characters. No preamble, no "a strong answer ` +
    `would", no markdown.\n\n`
  );
}

/** Trims a model answer to the stored shape, or drops it. */
export function sanitiseModelAnswer(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim().replace(/^```[a-z]*\n?|```$/g, "").trim();
  if (text.length < 40) return null;
  if (text.length <= MAX_MODEL_ANSWER_CHARS) return text;
  // Cut at the last sentence end that fits, so a trimmed answer still lands.
  const cut = text.slice(0, MAX_MODEL_ANSWER_CHARS);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
  return (stop > MAX_MODEL_ANSWER_CHARS / 2 ? cut.slice(0, stop + 1) : cut).trim();
}

/**
 * One call for the whole session: delivery for the round, content per
 * question. Every number that reaches the screen is derived from what the
 * model returned per axis, never asked for as a total — an overall the model
 * invents separately can contradict its own parts.
 */
export async function scoreRounds(rounds: RoundToScore[], withModelAnswers = true): Promise<SessionScore> {
  const result = await runTask("answer_scoring", {
    json: true,
    temperature: 0.2,
    ...buildScoringPrompt(rounds, withModelAnswers),
  });

  const parsed = parseJson<Record<string, unknown>>(result.text);

  const structure = clamp(parsed.structure);
  const specificity = clamp(parsed.specificity);
  const pace = clamp(parsed.pace);

  const byOrdinal = new Map<number, Record<string, unknown>>();
  if (Array.isArray(parsed.rounds)) {
    for (const entry of parsed.rounds) {
      if (entry && typeof entry === "object") {
        const e = entry as Record<string, unknown>;
        const ordinal = Number(e.ordinal);
        if (Number.isInteger(ordinal)) byOrdinal.set(ordinal, e);
      }
    }
  }

  const roundScores: RoundScore[] = rounds.map((r) => {
    const raw = byOrdinal.get(r.ordinal)?.detail;
    const given = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    // Only the rubric's own axes, all present, so the mean is over the same
    // things for every round of that type. A missing axis is a zero, not a
    // silent shrink of the denominator.
    const detail = Object.fromEntries(RUBRIC[r.type].map((k) => [k, clamp(given[k])]));
    const values = Object.values(detail);
    return {
      ordinal: r.ordinal,
      score: Math.round(values.reduce((a, b) => a + b, 0) / values.length),
      detail,
      modelAnswer: sanitiseModelAnswer(byOrdinal.get(r.ordinal)?.model_answer),
    };
  });

  return {
    structure,
    specificity,
    pace,
    overall: Math.round((structure + specificity + pace) / 3),
    note: typeof parsed.note === "string" ? parsed.note : "",
    rounds: roundScores,
    provider: `${result.provider}/${result.model}`,
  };
}
