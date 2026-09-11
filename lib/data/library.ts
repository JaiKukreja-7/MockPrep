import { createClient } from "@/lib/supabase/server";
import { sweepStaleSessions } from "@/lib/rounds/sweep";
import type { SessionStatus, Track } from "@/lib/supabase/types";

/* --------------------------------------------------------------------------
   Read models for Sessions, Reports and the question bank.

   Everything is scoped by RLS rather than an explicit user_id filter — the
   policies are the only thing standing between one user's rounds and
   another's, so the filtering must not be duplicated (and quietly diverge)
   up here.
   -------------------------------------------------------------------------- */

export const TRACKS: Track[] = ["consulting", "engineering", "product", "general"];

const dateFormat = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

function formatDate(iso: string | null) {
  return iso ? dateFormat.format(new Date(iso)) : null;
}

function formatDuration(seconds: number | null) {
  if (seconds === null) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** PostgREST returns a to-one embed as an object, an array when it cannot
 *  prove uniqueness. Accept both so a schema tweak cannot yield `undefined`. */
function oneOf<T>(embedded: T | T[] | null): T | null {
  if (!embedded) return null;
  return Array.isArray(embedded) ? (embedded[0] ?? null) : embedded;
}

export interface SessionListRow {
  id: string;
  title: string;
  track: Track;
  status: SessionStatus;
  date: string | null;
  length: string | null;
  overall: number | null;
  structure: number | null;
  specificity: number | null;
  pace: number | null;
}

export interface SessionList {
  rows: SessionListRow[];
  /** Only tracks the user actually has rounds in — no dead filters. */
  tracks: Track[];
  total: number;
}

export async function getSessions(track?: Track): Promise<SessionList | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  // Stale live rounds stop reading as "live" the moment someone looks.
  await sweepStaleSessions();

  let query = supabase
    .from("sessions")
    .select(
      "id, title, track, status, started_at, duration_seconds, scores(overall, structure, specificity, pace)",
    )
    .order("started_at", { ascending: false, nullsFirst: false })
    .limit(200);

  if (track) query = query.eq("track", track);

  // Tracks come from an unfiltered query: filtering by track and then reading
  // the available tracks off the result would leave exactly one filter.
  const [listed, allTracks] = await Promise.all([
    query,
    supabase.from("sessions").select("track"),
  ]);

  if (listed.error) throw listed.error;
  if (allTracks.error) throw allTracks.error;

  const present = new Set((allTracks.data ?? []).map((r) => r.track));

  return {
    rows: (listed.data ?? []).map((row) => {
      const score = oneOf(row.scores);
      return {
        id: row.id,
        title: row.title,
        track: row.track,
        status: row.status,
        date: formatDate(row.started_at),
        length: formatDuration(row.duration_seconds),
        overall: score?.overall ?? null,
        structure: score?.structure ?? null,
        specificity: score?.specificity ?? null,
        pace: score?.pace ?? null,
      };
    }),
    tracks: TRACKS.filter((t) => present.has(t)),
    total: allTracks.data?.length ?? 0,
  };
}

export interface ReportListRow {
  id: string;
  title: string;
  track: Track;
  date: string | null;
  length: string | null;
  overall: number;
}

export async function getReports(): Promise<ReportListRow[] | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabase
    .from("sessions")
    .select(
      "id, title, track, started_at, duration_seconds, scores(overall)",
    )
    .eq("status", "scored")
    .order("started_at", { ascending: false, nullsFirst: false })
    .limit(200);

  if (error) throw error;

  return (data ?? [])
    .map((row) => {
      const score = oneOf(row.scores);
      return score
        ? {
            id: row.id,
            title: row.title,
            track: row.track,
            date: formatDate(row.started_at),
            length: formatDuration(row.duration_seconds),
            overall: score.overall,
          }
        : null;
    })
    .filter((r): r is ReportListRow => r !== null);
}

export interface BankQuestion {
  question: string;
  track: Track;
  /** How many times this question has come up across the user's rounds. */
  asked: number;
}

/**
 * The question bank is derived from rounds already generated rather than a
 * table of its own: those rows ARE the questions this user has faced, and a
 * separate table would immediately disagree with them.
 */
export async function getQuestionBank(
  track?: Track,
): Promise<{ questions: BankQuestion[]; tracks: Track[] } | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabase
    .from("rounds")
    .select("question, created_at, sessions(track)")
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) throw error;

  const byQuestion = new Map<string, BankQuestion>();
  const present = new Set<Track>();

  for (const row of data ?? []) {
    const session = oneOf(row.sessions);
    const rowTrack = (session?.track ?? "general") as Track;
    present.add(rowTrack);

    if (track && rowTrack !== track) continue;

    const key = row.question.trim();
    const existing = byQuestion.get(key);
    if (existing) existing.asked += 1;
    else byQuestion.set(key, { question: key, track: rowTrack, asked: 1 });
  }

  return {
    questions: [...byQuestion.values()].sort((a, b) => b.asked - a.asked),
    tracks: TRACKS.filter((t) => present.has(t)),
  };
}
