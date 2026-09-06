import "server-only";
import { createClient } from "@/lib/supabase/server";
import { consumeQuota } from "@/lib/llm/quota";
import { scoreAnswer } from "@/lib/llm/tasks/score-answer";
import { extractFlags } from "@/lib/llm/tasks/extract-flags";

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

  const { data: lines } = await supabase
    .from("transcripts")
    .select("id, at_seconds, speaker, body")
    .eq("session_id", sessionId)
    .order("at_seconds", { ascending: true });

  if (!lines || lines.length === 0) return { ok: false, error: "Nothing to score yet." };

  const exchange = lines
    .map((l) => `${l.speaker === "interviewer" ? "Q" : "A"}: ${l.body}`)
    .join("\n\n");

  const indexed = lines.map((l, index) => ({
    index,
    speaker: l.speaker,
    body: l.body,
  }));

  try {
    // Independent, and each may spend its backoff ladder before failing over.
    const [score, flagResult] = await Promise.all([
      scoreAnswer({
        question: "The full exchange below is one mock interview round.",
        answer: exchange,
      }),
      extractFlags(indexed),
    ]);

    await supabase.from("scores").upsert({
      session_id: sessionId,
      overall: score.overall,
      structure: score.structure,
      specificity: score.specificity,
      pace: score.pace,
    });

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
      error: error instanceof Error ? `Scoring failed: ${error.message}` : "Scoring failed.",
    };
  }
}
