/**
 * "No session" and "could not check" are different answers, and the app used
 * to treat them the same: a Supabase outage bounced a signed-in user to the
 * sign-in page, and a sign-in attempt showed "fetch failed". Every place that
 * asks Supabase who the user is now asks this first.
 */

export const OUTAGE_MESSAGE =
  "MockPrep can't reach its database right now. Your account and your rounds " +
  "are safe on the server — wait a moment and try again.";

interface ErrorLike {
  name?: unknown;
  status?: unknown;
  message?: unknown;
  code?: unknown;
}

/**
 * True when an error from supabase-js means the request never got an answer
 * — connection refused, DNS, a dropped socket — as opposed to an answer that
 * said no. Auth surfaces these as AuthRetryableFetchError with status 0;
 * PostgREST calls surface them as a plain "TypeError: fetch failed".
 */
export function isSupabaseOutage(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as ErrorLike;
  if (e.name === "AuthRetryableFetchError") return true;
  if (e.status === 0) return true;
  const message = typeof e.message === "string" ? e.message : "";
  return /fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|socket hang up|network error|Failed to fetch/i.test(
    message,
  );
}
