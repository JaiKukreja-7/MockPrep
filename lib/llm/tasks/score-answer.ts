import "server-only";
import { runTask } from "../index";
import { parseJson } from "../json";
import type { QuestionType } from "@/lib/supabase/types";

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

/** Exported so the prompt's structure can be asserted without a model. */
export function buildScoringPrompt(rounds: RoundToScore[]) {
  const exchange = rounds
    .map((r) => {
      const head = `### Question ${r.ordinal} — type ${r.type}${r.topic ? ` (${r.topic})` : ""}`;
      const lines = [`Q: ${r.question}`, `A: ${r.answer}`];
      if (r.followUp) lines.push(`Follow-up: ${r.followUp}`, `A: ${r.followUpAnswer ?? "(no answer)"}`);
      return `${head}\nRubric: ${RUBRIC_GUIDE[r.type]}\n${lines.join("\n")}`;
    })
    .join("\n\n");

  const shape = rounds
    .map((r) => `{"ordinal": ${r.ordinal}, "detail": {${RUBRIC[r.type].map((k) => `"${k}": 0`).join(", ")}}}`)
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
      `Also write one sentence, addressed to the candidate, naming the single ` +
      `biggest thing to fix across the round. Sentence case.\n\n` +
      `Return exactly this shape:\n` +
      `{"structure": 0, "specificity": 0, "pace": 0, "note": "...", "rounds": [${shape}]}`,
  };
}

/**
 * One call for the whole session: delivery for the round, content per
 * question. Every number that reaches the screen is derived from what the
 * model returned per axis, never asked for as a total — an overall the model
 * invents separately can contradict its own parts.
 */
export async function scoreRounds(rounds: RoundToScore[]): Promise<SessionScore> {
  const result = await runTask("answer_scoring", {
    json: true,
    temperature: 0.2,
    ...buildScoringPrompt(rounds),
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
