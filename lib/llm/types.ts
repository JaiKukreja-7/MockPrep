/** Providers we can talk to. Adding one means adding a case in the registry. */
export type ProviderId = "gemini" | "groq" | "openrouter";

/**
 * Whether a provider may see content the user never chose to publish.
 *
 * `trains-on-free-tier` providers are structurally barred from tasks marked
 * sensitive — see lib/llm/routing.ts, which validates the whole table at
 * import time so a bad route fails at boot rather than mid-request.
 */
export type DataPolicy = "private" | "trains-on-free-tier";

export interface CompletionRequest {
  system: string;
  user: string;
  model: string;
  /** Ask for JSON. Callers must still tolerate prose — see parseJson. */
  json?: boolean;
  temperature?: number;
  /**
   * Every model here reasons before answering, and thinking tokens come out
   * of this budget. Too small a value returns an empty string, not an error.
   */
  maxOutputTokens?: number;
}

export interface CompletionResult {
  text: string;
  provider: ProviderId;
  model: string;
}

/**
 * How the backoff ladder should treat a failure.
 *
 *   true    walk the whole ladder — a 429 or a 5xx will likely clear.
 *   "once"  one retry, then fail over — an empty answer with a clean
 *           finish_reason is a provider hiccup that one more try usually
 *           fixes, and if it does not, waiting 2/4/8s more will not either.
 *   false   fail over now — a 400/401/404 is identical four seconds later.
 */
export type Retryable = boolean | "once";

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: ProviderId,
    readonly status?: number,
    readonly retryable: Retryable = false,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface LLMProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly dataPolicy: DataPolicy;
  isConfigured(): boolean;
  complete(
    request: CompletionRequest,
    signal?: AbortSignal,
  ): Promise<CompletionResult>;
}
