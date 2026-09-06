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
  const attempts: AttemptLog[] = [];

  for (const step of config.chain) {
    const provider = getProvider(step.provider);

    // Belt and braces: routing.ts already refuses to build an unsafe table,
    // but this re-checks with the request in hand, in case a chain is ever
    // assembled dynamically.
    if (config.sensitive && provider.dataPolicy !== "private") {
      throw new Error(
        `Refusing to send sensitive task "${task}" to ${step.provider} ` +
          `(data policy: ${provider.dataPolicy}).`,
      );
    }

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
