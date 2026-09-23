import { describe, expect, it } from "vitest";
import { MAX_MODEL_ANSWER_CHARS, RUBRIC, scoreRounds, type RoundToScore } from "@/lib/llm/tasks/score-answer";
import { modelAnswers } from "@/lib/llm/tasks/model-answers";

/**
 * Which route the model answers take: folded into the scoring call, or a
 * call of their own. Folded is one fewer provider call per round, so it wins
 * unless it is less reliable — this measures that rather than assuming it.
 *
 * Reliability for a run is: every round came back with a usable answer, of
 * the right length, and — for the folded route — the scores it returned
 * alongside are still complete. A scoring call that starts dropping axes
 * because it is also writing prose is the failure this is looking for.
 *
 * Opt-in: ~2 × repeats provider calls.
 *   MODEL_ANSWER_ROUTE=1 npm run measure:model-answers
 */

const ROUNDS: RoundToScore[] = [
  {
    ordinal: 1,
    type: "dsa",
    level: "fresher",
    topic: "two pointers",
    question:
      "Given a sorted array of integers and a target, find whether two numbers add up to it. For example [1,2,4,6,10] with target 8. Walk me through your approach, its time and space complexity, and what could break it.",
    answer: "I'd loop through the array and for each number check the rest of the array for the one that completes the pair.",
    followUp: null,
    followUpAnswer: null,
  },
  {
    ordinal: 2,
    type: "cs_fundamentals",
    level: "fresher",
    topic: "DBMS",
    question: "Why can adding an index to a table make some queries faster and others slower?",
    answer: "Indexes make lookups faster but they take up space, so it depends on the table.",
    followUp: null,
    followUpAnswer: null,
  },
  {
    ordinal: 3,
    type: "system_design",
    level: "fresher",
    topic: null,
    question: "Design a URL shortener. Walk me through the components, the data flow, and one trade-off.",
    answer: "A database with the URLs and a hash function to make the short code. Then you redirect.",
    followUp: "What happens when two long URLs hash to the same code?",
    followUpAnswer: "You'd have to check and change it.",
    },
  {
    ordinal: 4,
    type: "behavioural",
    level: "fresher",
    topic: null,
    question: "Tell me about a time you disagreed with a decision your team made.",
    answer: "I usually go along with the team, but sometimes I say what I think and we talk about it.",
    followUp: null,
    followUpAnswer: null,
  },
];

interface Outcome {
  ok: boolean;
  notes: string[];
  answers: string[];
}

function judge(got: Map<number, string>, scoresComplete: boolean | null): Outcome {
  const notes: string[] = [];
  for (const r of ROUNDS) {
    const a = got.get(r.ordinal);
    if (!a) {
      notes.push(`Q${r.ordinal} (${r.type}): no answer`);
      continue;
    }
    if (a.length > MAX_MODEL_ANSWER_CHARS) notes.push(`Q${r.ordinal}: ${a.length} chars`);
    if (/^(a strong answer|a good answer|model answer)/i.test(a)) notes.push(`Q${r.ordinal}: preamble`);
    if (/```|^#{1,3} /m.test(a)) notes.push(`Q${r.ordinal}: markdown`);
  }
  if (scoresComplete === false) notes.push("scores came back incomplete");
  return { ok: notes.length === 0, notes, answers: ROUNDS.map((r) => got.get(r.ordinal) ?? "") };
}

const enabled = Boolean(process.env.MODEL_ANSWER_ROUTE);

describe.skipIf(!enabled)("model answers: folded into scoring vs a call of their own", () => {
  const REPEATS = Number(process.env.MODEL_ANSWER_REPEATS ?? 3);

  it("folded is at least as reliable as separate", async () => {
    const tally = { folded: 0, separate: 0 };
    const log: string[] = [];
    let sample = "";

    for (let r = 0; r < REPEATS; r += 1) {
      const score = await scoreRounds(ROUNDS, true);
      const foldedMap = new Map(score.rounds.filter((x) => x.modelAnswer).map((x) => [x.ordinal, x.modelAnswer!]));
      const scoresComplete = score.rounds.every(
        (x) => Object.keys(x.detail).length === RUBRIC[ROUNDS.find((q) => q.ordinal === x.ordinal)!.type].length && x.score > 0,
      );
      const folded = judge(foldedMap, scoresComplete);
      if (folded.ok) tally.folded += 1;
      log.push(`  run ${r + 1} folded:   ${folded.ok ? "ok" : folded.notes.join("; ")}`);
      if (!sample && folded.answers[0]) sample = folded.answers[0];

      const { answers } = await modelAnswers(ROUNDS);
      const separate = judge(answers, null);
      if (separate.ok) tally.separate += 1;
      log.push(`  run ${r + 1} separate: ${separate.ok ? "ok" : separate.notes.join("; ")}`);
    }

    console.log(
      ["", `model-answer route over ${REPEATS} runs:`, `  folded:   ${tally.folded}/${REPEATS} clean`, `  separate: ${tally.separate}/${REPEATS} clean`, ...log, "", `sample (Q1, DSA):`, sample, ""].join("\n"),
    );

    // The decision this test exists to make. Folded is chosen when it is no
    // worse; if it falls behind, switch scoreSession to modelAnswers().
    expect(tally.folded, `folded lost to separate:\n${log.join("\n")}`).toBeGreaterThanOrEqual(tally.separate);
    expect(tally.folded / REPEATS, `folded was unreliable:\n${log.join("\n")}`).toBeGreaterThanOrEqual(0.8);
  }, 900_000);
});
