import { getProvider } from "./registry";
import type { ProviderId } from "./types";

export type LLMTask =
  | "question_generation"
  | "answer_scoring"
  | "flag_extraction"
  | "interviewer_turn"
  | "follow_up"
  | "resume_analysis"
  | "tailored_question_generation";

export interface RouteStep {
  provider: ProviderId;
  model: string;
}

export interface TaskConfig {
  /**
   * Content the user never chose to publish. Sensitive tasks may only route
   * to providers whose dataPolicy is "private" — enforced below at import
   * time, not by convention.
   */
  sensitive: boolean;
  /** Tried in order. Each step is a full failover target, not a retry. */
  chain: RouteStep[];
  maxOutputTokens: number;
}

/* ---------------------------------------------------------------------------
   THE ROUTE TABLE — the only place a task's provider or model is decided.
   Re-pointing a task is an edit here and nothing else.

   Two models named in the brief are not reachable on free tiers as of
   2026-09-05, and the substitutions are marked:

     gemini-2.5-flash        404 "no longer available to new users",
                             Google's own error points at gemini-3.6-flash
     deepseek/deepseek-r1:free
                             404 "This model is unavailable for free.
                             The paid version is available now"
--------------------------------------------------------------------------- */

export const TASKS: Record<LLMTask, TaskConfig> = {
  question_generation: {
    sensitive: false,
    chain: [
      // SUBSTITUTED for gemini-2.5-flash, which is closed to new API users.
      { provider: "gemini", model: "gemini-3.6-flash" },
      // Not in the brief; questions are generated from a role and a track,
      // carry no user content, and a dead round is worse than a fallback.
      { provider: "groq", model: "openai/gpt-oss-120b" },
    ],
    maxOutputTokens: 4000,
  },

  // Groq leads both scoring tasks. GLM-5.2's free pool returns shared-pool
  // 429s more often than not, and leading with it spent the whole 1/2/4/8s
  // ladder on every submit before failing over — 15s of latency for nothing.
  // OpenRouter stays as the fallback so the chain still has two legs.
  answer_scoring: {
    sensitive: false,
    chain: [
      { provider: "groq", model: "openai/gpt-oss-120b" },
      // SUBSTITUTED for deepseek/deepseek-r1:free, withdrawn from the free tier.
      { provider: "openrouter", model: "z-ai/glm-5.2:free" },
    ],
    maxOutputTokens: 6000,
  },

  flag_extraction: {
    sensitive: false,
    chain: [
      { provider: "groq", model: "openai/gpt-oss-120b" },
      { provider: "openrouter", model: "z-ai/glm-5.2:free" },
    ],
    maxOutputTokens: 6000,
  },

  // The voice brain. Gemini Flash leads, as specified for the voice chain.
  // It sees the candidate's spoken answer, which is why the reply is capped
  // short and the next question is passed through verbatim rather than
  // regenerated.
  interviewer_turn: {
    sensitive: false,
    chain: [
      { provider: "gemini", model: "gemini-3.6-flash" },
      { provider: "groq", model: "openai/gpt-oss-120b" },
    ],
    maxOutputTokens: 2000,
  },

  // One probing follow-up after a weak answer. Small, fast, and it sees the
  // candidate's answer, so it takes the same chain as the voice brain.
  follow_up: {
    sensitive: false,
    chain: [
      { provider: "groq", model: "openai/gpt-oss-120b" },
      { provider: "gemini", model: "gemini-3.6-flash" },
    ],
    maxOutputTokens: 1500,
  },

  resume_analysis: {
    // A resume is the user's own history, handed over to be analysed, not
    // published. Nothing here may reach a provider that can train on it.
    sensitive: true,
    chain: [{ provider: "groq", model: "openai/gpt-oss-120b" }],
    maxOutputTokens: 6000,
  },

  // Questions written against a resume and/or a job description. Its own
  // task, not question_generation with extra input: that one leads with
  // Gemini, and the resume text in this prompt must never go there. A job
  // description alone is not personal data, but the same task serves both so
  // the route does not depend on which inputs happened to be filled.
  tailored_question_generation: {
    sensitive: true,
    chain: [{ provider: "groq", model: "openai/gpt-oss-120b" }],
    maxOutputTokens: 5000,
  },
};

/**
 * Validates the whole table when this module is first imported, so a route
 * that would send a resume to a training-eligible provider crashes the server
 * at boot instead of leaking on the first request. A comment would not have
 * stopped that; this does.
 */
function assertDataPolicies() {
  for (const [task, config] of Object.entries(TASKS) as Array<
    [LLMTask, TaskConfig]
  >) {
    if (!config.sensitive) continue;

    for (const step of config.chain) {
      const policy = getProvider(step.provider).dataPolicy;
      if (policy !== "private") {
        throw new Error(
          `Routing table is unsafe: task "${task}" is marked sensitive but ` +
            `routes to "${step.provider}", whose data policy is "${policy}". ` +
            `Sensitive tasks may only use providers that do not train on ` +
            `submitted content.`,
        );
      }
    }
  }
}

/**
 * Every task must have at least one private-policy step, because any call
 * can be raised to sensitive at runtime — see TaskRequest.sensitive. A round
 * tailored to a resume does exactly that for scoring, follow-ups, flags and
 * the voice brain. Without a private leg such a call has nowhere to go and
 * fails; better to find that out at boot than mid-round.
 */
function assertEveryTaskCanBeRaised() {
  for (const [task, config] of Object.entries(TASKS) as Array<[LLMTask, TaskConfig]>) {
    const hasPrivate = config.chain.some(
      (step) => getProvider(step.provider).dataPolicy === "private",
    );
    if (!hasPrivate) {
      throw new Error(
        `Routing table is unsafe: task "${task}" has no provider with a ` +
          `private data policy, so a call raised to sensitive — a round ` +
          `tailored to a resume — could not run at all.`,
      );
    }
  }
}

assertDataPolicies();
assertEveryTaskCanBeRaised();
