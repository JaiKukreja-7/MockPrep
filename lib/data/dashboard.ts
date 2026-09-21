import { createClient } from "@/lib/supabase/server";
import type { QuestionType, Track, TranscriptFlag } from "@/lib/supabase/types";

/* --------------------------------------------------------------------------
   Read models for the dashboard. Everything here is scoped by RLS rather than
   by an explicit user_id filter — the policies in the migration are the only
   thing standing between one user's rounds and another's, so the filtering
   must not be duplicated (and quietly diverge) up here.
   -------------------------------------------------------------------------- */

export interface Breakdown {
  overall: number;
  structure: number;
  specificity: number;
  pace: number;
}

export interface RecentSession {
  id: string;
  title: string;
  track: Track;
  date: string | null;
  length: string | null;
  score: number | null;
}

export interface UpNext {
  title: string;
  when: string | null;
}

export interface FocusArea {
  flag: TranscriptFlag;
  label: string;
  flagCount: number;
  sessionCount: number;
}

export interface HeatmapData {
  cells: Array<{ date: string; count: number; column: number; row: number }>;
  months: Array<{ label: string; column: number }>;
  columns: number;
}

export interface TypeAverage {
  type: QuestionType;
  /** Mean per-round score across every scored round of this type. */
  average: number;
  rounds: number;
}

export interface DashboardData {
  latest: Breakdown | null;
  /** Content scores by question type, across all scored rounds. */
  byType: TypeAverage[];
  upNext: UpNext | null;
  recentSessions: RecentSession[];
  focusAreas: FocusArea[];
  heatmap: HeatmapData;
}

/** Each flag maps to the sentence the UI shows. A new enum value needs one. */
const FLAG_LABELS: Record<TranscriptFlag, string> = {
  restated: "Stop restating the question",
  filler: "Cut the filler",
  no_number: "Name the number",
  rambled: "Land the answer sooner",
};

// Dates render in the server's timezone. Fine while this is server-only, but
// it needs a real per-user timezone before any of this is sent to a client.
const dateFormat = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
});

const dateTimeFormat = new Intl.DateTimeFormat("en-AU", {
  weekday: "long",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

function formatDate(iso: string | null): string | null {
  return iso ? dateFormat.format(new Date(iso)) : null;
}

function formatDuration(seconds: number | null): string | null {
  if (seconds === null) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * PostgREST returns a to-one embed as an object, but returns an array when it
 * cannot prove the relationship is unique. Both shapes are accepted so a
 * schema tweak cannot turn the score column into `undefined` at runtime.
 */
function oneOf<T>(embedded: T | T[] | null): T | null {
  if (!embedded) return null;
  return Array.isArray(embedded) ? (embedded[0] ?? null) : embedded;
}

const WEEKS = 53;
const monthFormat = new Intl.DateTimeFormat("en-AU", { month: "short" });

/** yyyy-mm-dd in local time. toISOString() would shift the day either side of UTC. */
function isoDay(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Builds a 53-column grid ending today, one column per week, rows Monday
 * through Sunday. The grid always starts on a Monday so the rows stay
 * meaningful; that means it reaches back slightly more than 12 months.
 */
function buildHeatmap(startedAt: string[]): HeatmapData {
  const counts = new Map<string, number>();
  for (const iso of startedAt) {
    const key = isoDay(new Date(iso));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Walk back to the Monday of the earliest week in view.
  const start = new Date(today);
  start.setDate(start.getDate() - (WEEKS - 1) * 7);
  const mondayOffset = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - mondayOffset);

  const cells: HeatmapData["cells"] = [];
  const months: HeatmapData["months"] = [];
  let lastMonth = -1;

  const cursor = new Date(start);
  for (let i = 0; cursor <= today; i += 1) {
    const column = Math.floor(i / 7);
    const row = (cursor.getDay() + 6) % 7;
    const date = isoDay(cursor);

    cells.push({ date, count: counts.get(date) ?? 0, column, row });

    // One label per month, placed on the column where the month turns over.
    if (cursor.getMonth() !== lastMonth && row === 0) {
      lastMonth = cursor.getMonth();
      months.push({ label: monthFormat.format(cursor), column });
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  return { cells, months, columns: WEEKS };
}

export async function getNavCounts(): Promise<{
  sessions: number | null;
  reports: number | null;
  questions: number | null;
}> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { sessions: null, reports: null, questions: null };

  const [sessions, reports, questions] = await Promise.all([
    supabase.from("sessions").select("*", { count: "exact", head: true }),
    supabase
      .from("sessions")
      .select("*", { count: "exact", head: true })
      .eq("status", "scored"),
    supabase.from("rounds").select("*", { count: "exact", head: true }),
  ]);

  return {
    sessions: sessions.count ?? 0,
    reports: reports.count ?? 0,
    questions: questions.count ?? 0,
  };
}

export async function getDashboard(): Promise<DashboardData | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const yearAgo = new Date();
  yearAgo.setDate(yearAgo.getDate() - WEEKS * 7);

  const [recentResult, upNextResult, flagsResult, historyResult, typeResult] = await Promise.all([
    supabase
      .from("sessions")
      .select(
        "id, title, track, started_at, duration_seconds, scores(overall, structure, specificity, pace)",
      )
      .eq("status", "scored")
      .order("started_at", { ascending: false, nullsFirst: false })
      .limit(4),

    supabase
      .from("sessions")
      .select("id, title, scheduled_for")
      .in("status", ["draft", "live"])
      .not("scheduled_for", "is", null)
      .gte("scheduled_for", new Date().toISOString())
      .order("scheduled_for", { ascending: true })
      .limit(1)
      .maybeSingle(),

    supabase
      .from("flag_summary")
      .select("flag, flag_count, session_count")
      .order("flag_count", { ascending: false })
      .limit(2),

    supabase
      .from("sessions")
      .select("started_at")
      .not("started_at", "is", null)
      .gte("started_at", yearAgo.toISOString()),

    // Every scored round, one row each; grouped here. RLS keeps it to the
    // user's own sessions.
    supabase.from("rounds").select("question_type, score").not("score", "is", null),
  ]);

  if (recentResult.error) throw recentResult.error;
  if (upNextResult.error) throw upNextResult.error;
  if (flagsResult.error) throw flagsResult.error;
  if (historyResult.error) throw historyResult.error;

  const rows = recentResult.data ?? [];

  const sums = new Map<QuestionType, { total: number; n: number }>();
  for (const r of typeResult.data ?? []) {
    if (r.score === null) continue;
    const acc = sums.get(r.question_type) ?? { total: 0, n: 0 };
    acc.total += r.score;
    acc.n += 1;
    sums.set(r.question_type, acc);
  }
  const byType: TypeAverage[] = [...sums.entries()]
    .map(([type, { total, n }]) => ({ type, average: Math.round(total / n), rounds: n }))
    .sort((a, b) => b.rounds - a.rounds || a.type.localeCompare(b.type));

  const recentSessions: RecentSession[] = rows.map((row) => {
    const score = oneOf(row.scores);
    return {
      id: row.id,
      title: row.title,
      track: row.track,
      date: formatDate(row.started_at),
      length: formatDuration(row.duration_seconds),
      score: score?.overall ?? null,
    };
  });

  // "Last overall score" is the most recent scored session, which is already
  // the head of the list above — no second round-trip for it.
  const head = oneOf(rows[0]?.scores ?? null);
  const latest: Breakdown | null = head
    ? {
        overall: head.overall,
        structure: head.structure,
        specificity: head.specificity,
        pace: head.pace,
      }
    : null;

  const upNext: UpNext | null = upNextResult.data
    ? {
        title: upNextResult.data.title,
        when: upNextResult.data.scheduled_for
          ? dateTimeFormat.format(new Date(upNextResult.data.scheduled_for))
          : null,
      }
    : null;

  const focusAreas: FocusArea[] = (flagsResult.data ?? []).map((row) => ({
    flag: row.flag,
    label: FLAG_LABELS[row.flag],
    flagCount: row.flag_count,
    sessionCount: row.session_count,
  }));

  const heatmap = buildHeatmap(
    (historyResult.data ?? [])
      .map((row) => row.started_at)
      .filter((v): v is string => v !== null),
  );

  return { latest, byType, upNext, recentSessions, focusAreas, heatmap };
}
