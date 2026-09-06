"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { consumeQuota } from "@/lib/llm/quota";
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
 */
export async function startRound(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const track = (String(formData.get("track") ?? "general") || "general") as Track;
  const role = String(formData.get("role") ?? "").trim() || "Graduate analyst";
  const requestedMode = String(formData.get("mode") ?? "text") === "voice" ? "voice" : "text";

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
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
    return {
      error:
        error instanceof Error
          ? `Could not reach an interviewer: ${error.message}`
          : "Could not reach an interviewer.",
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
  if (roundsError) return { error: roundsError.message };

  redirect(`/session/${session.id}`);
}

/**
 * Records one answer. The last answer ends the round and triggers scoring.
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
  if (!outcome.ok) return { error: outcome.error };

  revalidatePath("/dashboard");
  redirect(`/report/${sessionId}`);
}
