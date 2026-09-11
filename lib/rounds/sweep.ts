import "server-only";
import { createClient } from "@/lib/supabase/server";

/**
 * How long a live round may sit silent before it is treated as walked away
 * from.
 *
 * One hour. A round is three questions and capped at ten minutes of speech,
 * so a genuine session is over in well under half an hour. An hour of
 * nothing — no answer submitted, no line spoken — is not a pause, it is a
 * closed laptop. Measured from the last thing that happened in the round,
 * not from when it started, so someone thinking for a while on question two
 * is not swept.
 *
 * Why this exists: a live session resumed days later showed its true elapsed
 * time since started_at — 6425:39 — which is accurate and useless.
 */
export const STALE_AFTER_MS = 60 * 60 * 1000;

interface Candidate {
  id: string;
  started_at: string | null;
  created_at: string;
}

function lastActivityMs(session: Candidate, lastLineAt: string | null): number {
  const marks = [session.started_at, session.created_at, lastLineAt]
    .filter((v): v is string => v !== null)
    .map((v) => new Date(v).getTime());
  return Math.max(...marks);
}

/**
 * Marks one live session abandoned if its last activity is older than the
 * threshold. Returns true if it was swept.
 *
 * Runs at read time rather than on a schedule, because reading is the only
 * moment the stale round is a problem: it is about to be resumed with a
 * wall-clock elapsed. A scheduled sweep (pg_cron) would tidy rounds nobody
 * ever comes back to, but needs setting up on the Supabase side.
 */
export async function sweepIfStale(sessionId: string): Promise<boolean> {
  const supabase = await createClient();

  const [sessionResult, lineResult] = await Promise.all([
    supabase
      .from("sessions")
      .select("id, status, started_at, created_at")
      .eq("id", sessionId)
      .maybeSingle(),
    supabase
      .from("transcripts")
      .select("created_at")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const session = sessionResult.data;
  if (!session || session.status !== "live") return false;

  const idleMs = Date.now() - lastActivityMs(session, lineResult.data?.created_at ?? null);
  if (idleMs < STALE_AFTER_MS) return false;

  const { error } = await supabase
    .from("sessions")
    .update({ status: "abandoned", ended_at: new Date().toISOString() })
    .eq("id", sessionId)
    .eq("status", "live");

  return !error;
}

/**
 * Sweeps every live session the current user owns. Called from the sessions
 * list, so stale rounds stop showing as "live" the moment someone looks.
 */
export async function sweepStaleSessions(): Promise<number> {
  const supabase = await createClient();

  const { data: live } = await supabase
    .from("sessions")
    .select("id, started_at, created_at")
    .eq("status", "live");

  if (!live || live.length === 0) return 0;

  // One query for the newest line per session, rather than one per session.
  const { data: lines } = await supabase
    .from("transcripts")
    .select("session_id, created_at")
    .in("session_id", live.map((s) => s.id))
    .order("created_at", { ascending: false });

  const newestLine = new Map<string, string>();
  for (const line of lines ?? []) {
    if (!newestLine.has(line.session_id)) newestLine.set(line.session_id, line.created_at);
  }

  const now = Date.now();
  const stale = live.filter(
    (s) => now - lastActivityMs(s, newestLine.get(s.id) ?? null) >= STALE_AFTER_MS,
  );
  if (stale.length === 0) return 0;

  const { error } = await supabase
    .from("sessions")
    .update({ status: "abandoned", ended_at: new Date().toISOString() })
    .in("id", stale.map((s) => s.id))
    .eq("status", "live");

  return error ? 0 : stale.length;
}
