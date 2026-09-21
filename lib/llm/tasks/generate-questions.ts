import "server-only";
import { runTask } from "../index";
import { parseJson } from "../json";
import type { ExperienceLevel, QuestionType, Track } from "@/lib/supabase/types";

/* ---------------------------------------------------------------------------
   THE PLAN — what kinds of question a round asks, per track.

   Engineering is the reason this file exists in this shape: the old prompt
   asked for "software engineering behavioural and system design" questions
   and got generic behavioural ones. A phone screen does not do that. It asks
   two problems, one fundamentals question and one design question, and it
   asks them the way a phone screen does — talk me through your approach,
   what is the complexity, what breaks it — because there is no editor.
--------------------------------------------------------------------------- */

export const ROUND_PLAN: Record<Track, QuestionType[]> = {
  engineering: ["dsa", "dsa", "cs_fundamentals", "system_design"],
  consulting: ["case", "case", "behavioural"],
  product: ["product_sense", "product_sense", "behavioural"],
  general: ["behavioural", "behavioural", "behavioural"],
};

/** DSA topic buckets, widening with level. Two are drawn per engineering round. */
export const DSA_TOPICS: Record<ExperienceLevel, string[]> = {
  intern: ["arrays", "strings", "hashing"],
  fresher: ["arrays", "strings", "hashing", "two pointers", "trees", "graphs"],
  junior: ["two pointers", "trees", "graphs", "dynamic programming", "hashing"],
};

export const CS_TOPICS = ["operating systems", "DBMS", "networks", "OOP"] as const;

export const LEVEL_BRIEF: Record<ExperienceLevel, string> = {
  intern:
    "an intern candidate: first internship, may not have finished a data " +
    "structures course. Easy problems with a clear brute force and one " +
    "better idea; fundamentals at the definition level; system design at " +
    "the level of naming the main components of a small app.",
  fresher:
    "a fresher: final year or just graduated, has done a DSA course. Medium " +
    "problems where the obvious approach is too slow; fundamentals with a " +
    "'why' behind them; system design of one service with a database and a " +
    "cache, asked for the trade-offs.",
  junior:
    "a candidate with one to three years of experience. Medium-to-hard " +
    "problems that reward choosing the right structure; fundamentals as " +
    "they show up in production (indexing, concurrency, failure modes); " +
    "system design that has to scale and has to choose between options.",
};

const TYPE_BRIEF: Record<QuestionType, string> = {
  dsa:
    "a data-structures-and-algorithms problem, stated fully in words with a " +
    "small example, and asked as a phone screen asks it: walk me through " +
    "your approach, then the time and space complexity, then what breaks it. " +
    "No code is expected; the candidate talks it through.",
  cs_fundamentals:
    "a computer-science fundamentals question with a concrete 'why' or " +
    "'what happens when', not a definition to recite.",
  system_design:
    "a system-design question sized to the level, naming what the system " +
    "must do and inviting the candidate to walk through components, data " +
    "flow and one trade-off.",
  behavioural: "a behavioural question about a real past situation.",
  case: "a consulting case prompt with a business situation and a decision to make.",
  product_sense:
    "a product-sense question: a product, a user, a decision, asked the way " +
    "a PM interviewer asks it.",
};

const TRACK_CONTEXT: Record<Track, string> = {
  consulting: "management consulting",
  engineering: "software engineering",
  product: "product management",
  general: "a graduate job",
};

export const LEVEL_LABEL: Record<ExperienceLevel, string> = {
  intern: "Intern",
  fresher: "Fresher",
  junior: "1–3 years",
};

export interface GenerateQuestionsInput {
  track: Track;
  role: string;
  level: ExperienceLevel;
  /** Injectable so tests get a deterministic draw. Defaults to Math.random. */
  random?: () => number;
}

export interface GeneratedQuestion {
  type: QuestionType;
  topic: string | null;
  question: string;
}

/** One slot of the plan, with its topic drawn where the type has topics. */
export interface PlannedSlot {
  type: QuestionType;
  topic: string | null;
}

/** Draws `n` distinct entries from `pool`. */
function draw<T>(pool: readonly T[], n: number, random: () => number): T[] {
  const rest = [...pool];
  const out: T[] = [];
  while (out.length < n && rest.length > 0) {
    const i = Math.floor(random() * rest.length);
    out.push(rest.splice(i, 1)[0]);
  }
  return out;
}

/** The plan for one round, topics drawn. Exported so the prompt is testable. */
export function planRound(track: Track, level: ExperienceLevel, random = Math.random): PlannedSlot[] {
  const plan = ROUND_PLAN[track];
  const dsaTopics = draw(DSA_TOPICS[level], plan.filter((t) => t === "dsa").length, random);
  const csTopics = draw(CS_TOPICS, plan.filter((t) => t === "cs_fundamentals").length, random);
  return plan.map((type) => ({
    type,
    topic: type === "dsa" ? (dsaTopics.shift() ?? null) : type === "cs_fundamentals" ? (csTopics.shift() ?? null) : null,
  }));
}

/** The prompt, built from the plan. Exported so its structure can be asserted. */
export function buildQuestionPrompt(input: {
  track: Track;
  role: string;
  level: ExperienceLevel;
  plan: PlannedSlot[];
}): { system: string; user: string } {
  const { track, role, level, plan } = input;
  const slots = plan
    .map(
      (slot, i) =>
        `${i + 1}. type "${slot.type}"${slot.topic ? ` on ${slot.topic}` : ""}: ${TYPE_BRIEF[slot.type]}`,
    )
    .join("\n");

  return {
    system:
      "You write interview questions for a mock interview trainer. " +
      "Return only JSON. No commentary, no markdown fences.",
    user:
      `Write ${plan.length} interview questions, in this order, for a candidate ` +
      `interviewing for "${role}" in ${TRACK_CONTEXT[track]}.\n\n` +
      `Pitch every question at ${LEVEL_BRIEF[level]}\n\n` +
      `The questions, in order:\n${slots}\n\n` +
      `Rules:\n` +
      `- Each question is what a real interviewer would say aloud: one to ` +
      `three sentences, sentence case, no numbering, no preamble.\n` +
      `- A DSA question must state the problem completely, including a tiny ` +
      `example, and end by asking for the approach and its complexity.\n` +
      `- Do not ask the same thing twice.\n\n` +
      `Return exactly this shape, one object per question, in order:\n` +
      `{"questions":[{"type":"dsa","topic":"two pointers","question":"..."}]}`,
  };
}

/**
 * Questions carry no user content — only a track, a role and a level — which
 * is why this task is not marked sensitive and can use the Gemini free tier.
 *
 * The plan decides the types; the model writes the words. If the model
 * mislabels a slot, the plan's type wins, because the type is what the round
 * is scored under.
 */
export async function generateQuestions({
  track,
  role,
  level,
  random = Math.random,
}: GenerateQuestionsInput): Promise<{ questions: GeneratedQuestion[]; provider: string }> {
  const plan = planRound(track, level, random);
  const prompt = buildQuestionPrompt({ track, role, level, plan });

  const result = await runTask("question_generation", {
    json: true,
    temperature: 0.8,
    ...prompt,
  });

  const parsed = parseJson<{ questions?: unknown }>(result.text);
  const raw = Array.isArray(parsed.questions) ? parsed.questions : [];

  const questions: GeneratedQuestion[] = raw
    .map((entry, i): GeneratedQuestion | null => {
      const slot = plan[i];
      if (!slot) return null;
      // Tolerate the old bare-string shape as well as the object shape.
      const question =
        typeof entry === "string"
          ? entry
          : entry && typeof entry === "object" && typeof (entry as { question?: unknown }).question === "string"
            ? (entry as { question: string }).question
            : "";
      if (!question.trim()) return null;
      const modelTopic =
        entry && typeof entry === "object" && typeof (entry as { topic?: unknown }).topic === "string"
          ? (entry as { topic: string }).topic.trim()
          : null;
      return {
        // The plan's type wins, whatever label the model put on the slot.
        type: slot.type,
        topic: slot.topic ?? modelTopic,
        question: question.trim(),
      };
    })
    .filter((q): q is GeneratedQuestion => q !== null);

  if (questions.length === 0) {
    throw new Error("Question generation returned no usable questions.");
  }

  return { questions, provider: `${result.provider}/${result.model}` };
}
