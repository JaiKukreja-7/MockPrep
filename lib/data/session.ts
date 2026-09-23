import { createClient } from "@/lib/supabase/server";
import type { QuestionSource, QuestionType, RoundMode, SessionRow, TranscriptRow } from "@/lib/supabase/types";

export interface RoundView {
  id: string;
  ordinal: number;
  question: string;
  type: QuestionType;
  topic: string | null;
  /** Where a tailored question came from; null for the standard plan. */
  source: QuestionSource | null;
  /** The probing follow-up, once asked. */
  followUp: string | null;
  /** What the round is asking right now: the follow-up if pending, else the question. */
  prompt: string;
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
  const full = await supabase
    .from("rounds")
    .select("id, ordinal, question, answered_at, mode, question_type, topic, source, follow_up")
    .eq("session_id", sessionId)
    .order("ordinal", { ascending: true });

  if (!full.error) return full;

  // Older schema: no voice or question-type columns yet.
  const bare = await supabase
    .from("rounds")
    .select("id, ordinal, question, answered_at")
    .eq("session_id", sessionId)
    .order("ordinal", { ascending: true });

  return {
    ...bare,
    data:
      bare.data?.map((r) => ({
        ...r,
        mode: "text" as const,
        question_type: "behavioural" as const,
        topic: null,
        source: null,
        follow_up: null,
      })) ?? null,
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
    type: r.question_type ?? "behavioural",
    topic: r.topic ?? null,
    source: r.source ?? null,
    followUp: r.follow_up ?? null,
    prompt: r.follow_up ?? r.question,
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

export interface ReportRound {
  id: string;
  ordinal: number;
  question: string;
  type: QuestionType;
  topic: string | null;
  source: QuestionSource | null;
  followUp: string | null;
  /** What a strong answer would have been. Written with the score. */
  modelAnswer: string | null;
  score: number | null;
  detail: Record<string, number> | null;
}

export interface ReportView {
  session: Pick<
    SessionRow,
    "id" | "title" | "track" | "status" | "started_at" | "duration_seconds" | "job_title" | "company" | "tailored_from_resume"
  >;
  score: { overall: number; structure: number; specificity: number; pace: number } | null;
  transcript: Array<Pick<TranscriptRow, "id" | "at_seconds" | "speaker" | "body" | "flag">>;
  /** Per-question scores under each type's rubric. */
  rounds: ReportRound[];
}

export async function getReport(id: string): Promise<ReportView | null> {
  const supabase = await createClient();

  const [sessionResult, roundsResult, scoreResult, transcriptResult] = await Promise.all([
    supabase
      .from("sessions")
      .select("id, title, track, status, started_at, duration_seconds, job_title, company, tailored_from_resume")
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("rounds")
      .select("id, ordinal, question, question_type, topic, source, follow_up, score, score_detail, model_answer")
      .eq("session_id", id)
      .order("ordinal", { ascending: true }),
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
    rounds: (roundsResult.data ?? []).map((r) => ({
      id: r.id,
      ordinal: r.ordinal,
      question: r.question,
      type: r.question_type,
      topic: r.topic,
      source: r.source,
      followUp: r.follow_up,
      modelAnswer: r.model_answer,
      score: r.score,
      detail: r.score_detail,
    })),
  };
}
