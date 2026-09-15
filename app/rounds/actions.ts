"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { OUTAGE_MESSAGE } from "@/lib/supabase/outage";
import { currentUser } from "@/lib/supabase/user";
import { consumeQuota, refundQuota } from "@/lib/llm/quota";
import { describeLlmFailure } from "@/lib/llm/user-message";
import { generateQuestions } from "@/lib/llm/tasks/generate-questions";
import { scoreSession } from "@/lib/rounds/score";
import type { RoundMode, Track } from "@/lib/supabase/types";

const QUESTIONS_PER_ROUND = 3;

export interface ActionState {
  error?: string;
}

/**
 * Starts a round: generates the questions, writes the session and its rounds,
 * then hands off to the live screen.
 *
 * The request is charged before generation — the cap is a spend control on
 * provider calls, so someone at the cap must not be able to trigger them —
 * and refunded on every path where no round comes of it.
 */
export async function startRound(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const track = (String(formData.get("track") ?? "general") || "general") as Track;
  const role = String(formData.get("role") ?? "").trim() || "Graduate analyst";
  const requestedMode = String(formData.get("mode") ?? "text") === "voice" ? "voice" : "text";

  const supabase = await createClient();
  const { user, outage } = await currentUser(supabase);
  if (outage) return { error: OUTAGE_MESSAGE };
  if (!user) return { error: "Sign in to start a round." };

  // Voice needs a real account. RLS enforces this too — the restrictive
  // policy on rounds rejects a guest's voice insert even via the API — but
  // checking here turns a policy violation into a sentence someone can read.
  const { data: profile } = await supabase
    .from("users")
    .select("is_guest")
    .eq("id", user.id)
    .maybeSingle();

  const mode: RoundMode =
    requestedMode === "voice" && profile && !profile.is_guest ? "voice" : "text";

  if (requestedMode === "voice" && mode === "text") {
    return { error: "Voice rounds need an account. Add an email to unlock them." };
  }

  const quota = await consumeQuota(1);
  if (!quota.allowed) {
    return {
      error: `Daily limit reached — ${quota.used} of ${quota.cap} rounds used today.`,
    };
  }

  let questions: string[];
  try {
    ({ questions } = await generateQuestions({
      track,
      role,
      count: QUESTIONS_PER_ROUND,
    }));
  } catch (error) {
    await refundQuota(1);
    return {
      error: describeLlmFailure(
        error,
        "Could not write your questions",
        "Try again in a minute — you have not been charged a round.",
      ),
    };
  }

  const { data: session, error: sessionError } = await supabase
    .from("sessions")
    .insert({
      user_id: user.id,
      title: role,
      track,
      status: "live",
      started_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (sessionError || !session) {
    await refundQuota(1);
    return { error: sessionError?.message ?? "Could not start the round." };
  }

  // `mode` is only written for voice rounds, so text mode keeps working on a
  // database that has not had the voice migration applied yet — the column
  // defaults to 'text' once it exists, and does not need to exist before then.
  const { error: roundsError } = await supabase.from("rounds").insert(
    questions.map((question, i) => ({
      session_id: session.id,
      ordinal: i + 1,
      question,
      asked_at: new Date().toISOString(),
      ...(mode === "voice" ? { mode } : {}),
    })),
  );
  if (roundsError) {
    await refundQuota(1);
    return { error: roundsError.message };
  }

  redirect(`/session/${session.id}`);
}

/**
 * Records one answer. The last answer ends the round and triggers scoring.
 *
 * Idempotent on a round that is already answered: a second submit — after a
 * scoring failure, a double click, a retry from a dead connection — writes
 * nothing and goes straight to whatever is left to do. The first version
 * inserted the transcript lines again on every retry.
 */
export async function submitAnswer(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const sessionId = String(formData.get("sessionId") ?? "");
  const roundId = String(formData.get("roundId") ?? "");
  const question = String(formData.get("question") ?? "");
  const answer = String(formData.get("answer") ?? "").trim();
  const elapsed = Number(formData.get("elapsed") ?? 0) || 0;

  if (!answer) return { error: "Write an answer before submitting." };

  const supabase = await createClient();
  const { user, outage } = await currentUser(supabase);
  if (outage) return { error: OUTAGE_MESSAGE };
  if (!user) return { error: "Your sign-in has expired. Sign in again in a new tab, then submit — your answer stays here." };

  const { data: round } = await supabase
    .from("rounds")
    .select("id, session_id, answered_at")
    .eq("id", roundId)
    .maybeSingle();

  if (!round || round.session_id !== sessionId) {
    return { error: "That question is not part of this round any more. Reload the page." };
  }

  if (!round.answered_at) {
    const { error: insertError } = await supabase.from("transcripts").insert([
      {
        session_id: sessionId,
        round_id: roundId,
        at_seconds: Math.max(0, elapsed - 1),
        speaker: "interviewer",
        body: question,
      },
      {
        session_id: sessionId,
        round_id: roundId,
        at_seconds: elapsed,
        speaker: "candidate",
        body: answer,
      },
    ]);
    if (insertError) return { error: insertError.message };

    await supabase
      .from("rounds")
      .update({ answered_at: new Date().toISOString() })
      .eq("id", roundId);
  }

  const { count } = await supabase
    .from("rounds")
    .select("*", { count: "exact", head: true })
    .eq("session_id", sessionId)
    .is("answered_at", null);

  if ((count ?? 0) > 0) {
    revalidatePath(`/session/${sessionId}`);
    return {};
  }

  const outcome = await scoreSession(sessionId, elapsed);
  if (!outcome.ok) {
    // The answers are saved and every round is answered; the session page
    // now shows the scoring affordance on reload, so a retry never re-submits.
    revalidatePath(`/session/${sessionId}`);
    return { error: outcome.error };
  }

  revalidatePath("/dashboard");
  redirect(`/report/${sessionId}`);
}

/**
 * Scores a round whose every question is answered but whose scoring never
 * went through — the providers were down at the moment of the last submit,
 * or the day's cap was hit there. Reached from the session screen and from
 * the unscored report.
 */
export async function scoreRound(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const sessionId = String(formData.get("sessionId") ?? "");
  if (!sessionId) return { error: "Which round?" };

  const supabase = await createClient();
  const { user, outage } = await currentUser(supabase);
  if (outage) return { error: OUTAGE_MESSAGE };
  if (!user) return { error: "Your sign-in has expired. Sign in again, then come back to score this round." };

  const { data: session } = await supabase
    .from("sessions")
    .select("id, status")
    .eq("id", sessionId)
    .maybeSingle();
  if (!session) return { error: "That round could not be found." };
  if (session.status === "scored") redirect(`/report/${sessionId}`);
  if (session.status === "abandoned") {
    return { error: "That round timed out and cannot be scored. Start a new one." };
  }

  const { count } = await supabase
    .from("rounds")
    .select("*", { count: "exact", head: true })
    .eq("session_id", sessionId)
    .is("answered_at", null);
  if ((count ?? 0) > 0) {
    return { error: "There are still questions to answer before this round can be scored." };
  }

  const { data: transcript } = await supabase
    .from("transcripts")
    .select("at_seconds")
    .eq("session_id", sessionId)
    .order("at_seconds", { ascending: false })
    .limit(1);
  const durationSeconds = transcript?.[0]?.at_seconds ?? 0;

  const outcome = await scoreSession(sessionId, durationSeconds);
  if (!outcome.ok) return { error: outcome.error };

  revalidatePath("/dashboard");
  revalidatePath(`/session/${sessionId}`);
  redirect(`/report/${sessionId}`);
}
