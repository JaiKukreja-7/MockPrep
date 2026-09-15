import "server-only";
import { AllProvidersFailedError } from "./index";
import { QuotaExceededError } from "./quota";

/**
 * One sentence for the screen; the whole story for the log.
 *
 * AllProvidersFailedError's message is the attempt log — every provider,
 * model, attempt number and upstream error — which is exactly what a log
 * line needs and exactly what a person under interview pressure does not.
 * The three places that used to put it on screen route through here.
 *
 * `what` is the clause that names the job that failed, sentence case, no
 * trailing punctuation: "Could not write your questions".
 */
export function describeLlmFailure(error: unknown, what: string, afterwards = "Try again in a minute."): string {
  if (error instanceof QuotaExceededError) return error.message;

  if (error instanceof AllProvidersFailedError) {
    console.error(`[mockprep] ${what}: ${error.message}`);
    return `${what}: every AI provider is rate-limited or down right now. ${afterwards}`;
  }

  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[mockprep] ${what}: ${detail}`);
  return `${what}. ${afterwards}`;
}
