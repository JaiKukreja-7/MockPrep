import "server-only";
import { withBackoff, type AttemptLog } from "./queue";
import { getProvider } from "./registry";
import { TASKS, type LLMTask } from "./routing";
import { ProviderError, type CompletionResult } from "./types";

export interface TaskRequest {
  system: string;
  user: string;
  json?: boolean;
  temperature?: number;
  /**
   * Raise this call to sensitive even when its task is not.
   *
   * A task's `sensitive` flag is about the content that task ALWAYS sees.
   * This is for content that only some calls carry: a round tailored to a
   * resume puts the candidate's own projects and employers into the
   * question text, and that text then reaches scoring, follow-ups and the
   * voice brain — tasks that are not sensitive in general. The session
   * decides, so the flag travels with the call, not the table.
   *
   * The effect is the same either way: every step whose provider may train
   * on submitted content is dropped from the chain before the first
   * request, and if that empties the chain the call fails rather than
   * falling back to a training-eligible provider.
   */
  sensitive?: boolean;
}

export interface TaskResult extends CompletionResult {
  /** Every failed attempt, in order. Useful when the answer looks odd. */
  attempts: AttemptLog[];
}

export class AllProvidersFailedError extends Error {
  constructor(
    readonly task: LLMTask,
    readonly attempts: AttemptLog[],
  ) {
    super(
      `Every provider for "${task}" failed:\n` +
        attempts
          .map((a) => `  ${a.provider}/${a.model} #${a.attempt}: ${a.error}`)
          .join("\n"),
    );
    this.name = "AllProvidersFailedError";
  }
}

/**
 * Runs a task down its provider chain.
 *
 * Each step gets the full backoff ladder before the next step is tried, so a
 * provider that is merely rate-limited is waited out rather than abandoned,
 * while one that is down or misconfigured is skipped quickly.
 */
export async function runTask(
  task: LLMTask,
  request: TaskRequest,
): Promise<TaskResult> {
  const config = TASKS[task];
  const sensitive = config.sensitive || request.sensitive === true;
  const attempts: AttemptLog[] = [];

  // A call raised to sensitive keeps only the private-policy steps, and the
  // filter is what enforces it — not a check inside the loop, which a step
  // added to the chain at runtime could still slip past on some other path.
  // The table's own sensitive tasks are already private-only (routing.ts
  // refuses to build anything else), so this changes nothing for them.
  const chain = sensitive
    ? config.chain.filter((step) => getProvider(step.provider).dataPolicy === "private")
    : config.chain;

  if (chain.length === 0) {
    throw new Error(
      `Refusing to run "${task}" as sensitive: no provider in its chain has ` +
        `a private data policy. Add one to lib/llm/routing.ts rather than ` +
        `letting this content reach a provider that may train on it.`,
    );
  }

  for (const step of chain) {
    const provider = getProvider(step.provider);

    if (!provider.isConfigured()) {
      attempts.push({
        provider: step.provider,
        model: step.model,
        attempt: 0,
        error: "no API key configured",
      });
      continue;
    }

    try {
      const result = await withBackoff(
        () =>
          provider.complete({
            system: request.system,
            user: request.user,
            model: step.model,
            json: request.json,
            temperature: request.temperature,
            maxOutputTokens: config.maxOutputTokens,
          }),
        (attempt, error) => {
          attempts.push({
            provider: step.provider,
            model: step.model,
            attempt,
            error:
              error instanceof ProviderError
                ? error.message
                : String(error instanceof Error ? error.message : error),
          });
        },
      );

      return { ...result, attempts };
    } catch {
      // Attempts are already logged by the callback; move down the chain.
      continue;
    }
  }

  throw new AllProvidersFailedError(task, attempts);
}

export type { LLMTask } from "./routing";
