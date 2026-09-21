import "server-only";
import { createClient } from "@/lib/supabase/server";
import { consumeQuota } from "@/lib/llm/quota";
import { scoreRounds, type RoundToScore } from "@/lib/llm/tasks/score-answer";
import { extractFlags } from "@/lib/llm/tasks/extract-flags";
import { describeLlmFailure } from "@/lib/llm/user-message";

export interface ScoreOutcome {
  ok: boolean;
  error?: string;
}

/**
 * Scores a finished round and writes the result back.
 *
 * Shared by the text action and the voice endpoint — the scoring pipeline
 * must not fork by mode, or the two paths drift and a voice score stops
 * meaning the same thing as a text one.
 */
export async function scoreSession(
  sessionId: string,
  durationSeconds: number,
): Promise<ScoreOutcome> {
  const supabase = await createClient();

  const quota = await consumeQuota(1);
  if (!quota.allowed) {
    return {
      ok: false,
      error: `Daily limit reached — ${quota.used} of ${quota.cap} rounds used today.`,
    };
  }

  const [{ data: lines }, { data: rounds }] = await Promise.all([
    supabase
      .from("transcripts")
      .select("id, round_id, at_seconds, speaker, body")
      .eq("session_id", sessionId)
      .order("at_seconds", { ascending: true }),
    supabase
      .from("rounds")
      .select("id, ordinal, question, question_type, topic, follow_up")
      .eq("session_id", sessionId)
      .order("ordinal", { ascending: true }),
  ]);

  if (!lines || lines.length === 0) return { ok: false, error: "Nothing to score yet." };

  // Each round's exchange from its own transcript lines: the first candidate
  // line answers the question, the second (if any) answers the follow-up.
  const toScore: RoundToScore[] = (rounds ?? []).map((r) => {
    const said = lines.filter((l) => l.round_id === r.id && l.speaker === "candidate");
    return {
      ordinal: r.ordinal,
      type: r.question_type,
      topic: r.topic,
      question: r.question,
      answer: said[0]?.body ?? "",
      followUp: r.follow_up,
      followUpAnswer: r.follow_up ? (said[1]?.body ?? null) : null,
    };
  });

  const indexed = lines.map((l, index) => ({
    index,
    speaker: l.speaker,
    body: l.body,
  }));

  try {
    // Independent, and each may spend its backoff ladder before failing over.
    const [score, flagResult] = await Promise.all([
      scoreRounds(toScore),
      extractFlags(indexed),
    ]);

    await supabase.from("scores").upsert({
      session_id: sessionId,
      overall: score.overall,
      structure: score.structure,
      specificity: score.specificity,
      pace: score.pace,
    });

    // Per-round content scores, under each round's own rubric.
    const roundById = new Map((rounds ?? []).map((r) => [r.ordinal, r.id]));
    await Promise.all(
      score.rounds.map((rs) => {
        const id = roundById.get(rs.ordinal);
        return id
          ? supabase.from("rounds").update({ score: rs.score, score_detail: rs.detail }).eq("id", id)
          : Promise.resolve();
      }),
    );

    await Promise.all(
      flagResult.flags.map((f) =>
        supabase.from("transcripts").update({ flag: f.flag }).eq("id", lines[f.index].id),
      ),
    );

    await supabase
      .from("sessions")
      .update({
        status: "scored",
        ended_at: new Date().toISOString(),
        duration_seconds: durationSeconds,
      })
      .eq("id", sessionId);

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: describeLlmFailure(
        error,
        "Scoring did not go through",
        "Your answers are saved — score the round again in a minute.",
      ),
    };
  }
}
