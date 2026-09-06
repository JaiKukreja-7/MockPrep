import "server-only";
import { ProviderError } from "./types";

/** 1s, 2s, 4s, 8s — four retries, then the chain fails over. */
const BACKOFF_MS = [1000, 2000, 4000, 8000];

/**
 * How many upstream calls may be in flight at once, process-wide.
 *
 * Free tiers rate-limit on concurrency as much as on volume, so requests
 * queue here rather than all hitting a 429 together and then all backing off
 * in lockstep. This is per server instance: a multi-instance deployment needs
 * this moved to Redis or the provider's own quota, not left as-is.
 */
const CONCURRENCY = 2;

let active = 0;
const waiting: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active < CONCURRENCY) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
}

function release() {
  active -= 1;
  const next = waiting.shift();
  if (next) next();
}

/** Runs `fn` when a slot frees up. */
export async function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface AttemptLog {
  provider: string;
  model: string;
  attempt: number;
  error: string;
}

/**
 * Retries one provider through the backoff ladder.
 *
 * Only retryable failures wait — a 401 or a 400 will fail identically four
 * seconds later, so those give up immediately and let the caller fail over.
 * A provider's own Retry-After wins when it is longer than our next step.
 */
export async function withBackoff<T>(
  fn: () => Promise<T>,
  onAttemptFailed?: (attempt: number, error: unknown) => void,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt += 1) {
    try {
      return await enqueue(fn);
    } catch (error) {
      lastError = error;
      onAttemptFailed?.(attempt, error);

      const retryable =
        error instanceof ProviderError ? error.retryable : false;
      const isLast = attempt === BACKOFF_MS.length;
      if (!retryable || isLast) break;

      const base = BACKOFF_MS[attempt];
      const suggested =
        error instanceof ProviderError ? (error.retryAfterMs ?? 0) : 0;
      await sleep(Math.max(base, suggested));
    }
  }

  throw lastError;
}
