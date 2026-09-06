import { createClient } from "@/lib/supabase/server";
import type { RoundMode, SessionRow, TranscriptRow } from "@/lib/supabase/types";

export interface RoundView {
  id: string;
  ordinal: number;
  question: string;
  answered: boolean;
  mode: RoundMode;
}

export interface SessionView {
  session: Pick<SessionRow, "id" | "title" | "track" | "status" | "started_at">;
  rounds: RoundView[];
  transcript: Array<Pick<TranscriptRow, "id" | "at_seconds" | "speaker" | "body" | "flag">>;
  current: RoundView | null;
  elapsedSeconds: number;
  /** Voice needs a real account; guests are text-only. */
  isGuest: boolean;
}


/**
 * Reads the rounds, tolerating a database without the voice migration.
 *
 * Selecting a column that does not exist is a hard 400 from PostgREST, so an
 * unguarded `mode` in the select would take text mode down on any environment
 * that has not run 20260905020000_voice.sql yet.
 */
async function selectRounds(
  supabase: Awaited<ReturnType<typeof createClient>>,
  sessionId: string,
) {
  const withMode = await supabase
    .from("rounds")
    .select("id, ordinal, question, answered_at, mode")
    .eq("session_id", sessionId)
    .order("ordinal", { ascending: true });

  if (!withMode.error) return withMode;

  const withoutMode = await supabase
    .from("rounds")
    .select("id, ordinal, question, answered_at")
    .eq("session_id", sessionId)
    .order("ordinal", { ascending: true });

  return {
    ...withoutMode,
    data: withoutMode.data?.map((r) => ({ ...r, mode: "text" as const })) ?? null,
  };
}

export async function getSession(id: string): Promise<SessionView | null> {
  const supabase = await createClient();

  const [sessionResult, roundsResult, transcriptResult] = await Promise.all([
    supabase
      .from("sessions")
      .select("id, title, track, status, started_at")
      .eq("id", id)
      .maybeSingle(),
    selectRounds(supabase, id),
    supabase
      .from("transcripts")
      .select("id, at_seconds, speaker, body, flag")
      .eq("session_id", id)
      .order("at_seconds", { ascending: true }),
  ]);

  if (!sessionResult.data) return null;

  const rounds: RoundView[] = (roundsResult.data ?? []).map((r) => ({
    id: r.id,
    ordinal: r.ordinal,
    question: r.question,
    answered: r.answered_at !== null,
    mode: r.mode ?? "text",
  }));

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile } = user
    ? await supabase.from("users").select("is_guest").eq("id", user.id).maybeSingle()
    : { data: null };

  const startedAt = sessionResult.data.started_at;
  const elapsedSeconds = startedAt
    ? Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000))
    : 0;

  return {
    session: sessionResult.data,
    rounds,
    transcript: transcriptResult.data ?? [],
    current: rounds.find((r) => !r.answered) ?? null,
    elapsedSeconds,
    isGuest: profile?.is_guest ?? true,
  };
}

export interface ReportView {
  session: Pick<SessionRow, "id" | "title" | "track" | "started_at" | "duration_seconds">;
  score: { overall: number; structure: number; specificity: number; pace: number } | null;
  transcript: Array<Pick<TranscriptRow, "id" | "at_seconds" | "speaker" | "body" | "flag">>;
}

export async function getReport(id: string): Promise<ReportView | null> {
  const supabase = await createClient();

  const [sessionResult, scoreResult, transcriptResult] = await Promise.all([
    supabase
      .from("sessions")
      .select("id, title, track, started_at, duration_seconds")
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("scores")
      .select("overall, structure, specificity, pace")
      .eq("session_id", id)
      .maybeSingle(),
    supabase
      .from("transcripts")
      .select("id, at_seconds, speaker, body, flag")
      .eq("session_id", id)
      .order("at_seconds", { ascending: true }),
  ]);

  if (!sessionResult.data) return null;

  return {
    session: sessionResult.data,
    score: scoreResult.data ?? null,
    transcript: transcriptResult.data ?? [],
  };
}
