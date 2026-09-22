"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { OUTAGE_MESSAGE } from "@/lib/supabase/outage";
import { currentUser } from "@/lib/supabase/user";
import { consumeQuota, refundQuota } from "@/lib/llm/quota";
import { describeLlmFailure } from "@/lib/llm/user-message";
import { generateQuestions, type GeneratedQuestion, type Tailoring } from "@/lib/llm/tasks/generate-questions";
import { generateTailoredQuestions } from "@/lib/llm/tasks/tailored-questions";
import { extractResume, ResumeExtractionError } from "@/lib/resume/extract";
import { followUp } from "@/lib/llm/tasks/follow-up";
import { scoreSession } from "@/lib/rounds/score";
import type { ExperienceLevel, RoundMode, Track } from "@/lib/supabase/types";

const LEVELS: ExperienceLevel[] = ["intern", "fresher", "junior"];

export interface ActionState {
  error?: string;
}

/** The job description is stored on the session; this is the most of it that is. */
const MAX_JD_CHARS = 8_000;

/**
 * Starts a round: generates the questions, writes the session and its rounds,
 * then hands off to the live screen.
 *
 * The request is charged before generation — the cap is a spend control on
 * provider calls, so someone at the cap must not be able to trigger them —
 * and refunded on every path where no round comes of it.
 *
 * A round can be tailored to a resume, a job, or both. The resume is parsed
 * in memory here and goes nowhere but the sensitive generation task; the
 * variable holding its text falls out of scope with this function and only
 * the questions it produced are written. The job details are stored on the
 * session — they are the user's target, not their history.
 */
export async function startRound(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const track = (String(formData.get("track") ?? "general") || "general") as Track;
  const role = String(formData.get("role") ?? "").trim() || "Graduate analyst";
  const requestedMode = String(formData.get("mode") ?? "text") === "voice" ? "voice" : "text";
  const levelRaw = String(formData.get("level") ?? "fresher");
  const level: ExperienceLevel = LEVELS.includes(levelRaw as ExperienceLevel)
    ? (levelRaw as ExperienceLevel)
    : "fresher";

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

  // Tailoring inputs. A resume needs a real account — RLS rejects a guest's
  // tailored_from_resume session regardless — and is read before the quota
  // is charged, so a scan that yields nothing costs no request.
  const file = formData.get("resume");
  const hasFile = file instanceof File && file.size > 0;
  const jobTitle = String(formData.get("jobTitle") ?? "").trim();
  const company = String(formData.get("company") ?? "").trim();
  const jobDescription = String(formData.get("jobDescription") ?? "").trim().slice(0, MAX_JD_CHARS);
  const job = jobTitle || jobDescription ? { title: jobTitle, company, description: jobDescription } : undefined;

  if (hasFile && (!profile || profile.is_guest)) {
    return { error: "Tailoring to a resume needs an account. Add an email to unlock it." };
  }

  let resumeText: string | undefined;
  if (hasFile) {
    try {
      ({ text: resumeText } = await extractResume(file));
    } catch (error) {
      return {
        error: error instanceof ResumeExtractionError ? error.message : "That file could not be read.",
      };
    }
  }
  const tailoring: Tailoring | null = resumeText || job ? { resumeText, job } : null;

  const quota = await consumeQuota(1);
  if (!quota.allowed) {
    return {
      error: `Daily limit reached — ${quota.used} of ${quota.cap} rounds used today.`,
    };
  }

  let questions: GeneratedQuestion[];
  try {
    ({ questions } = tailoring
      ? await generateTailoredQuestions({ track, role, level, tailoring })
      : await generateQuestions({ track, role, level }));
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
      level,
      status: "live",
      started_at: new Date().toISOString(),
      ...(job ? { job_title: job.title || null, company: job.company || null, job_description: job.description || null } : {}),
      ...(resumeText ? { tailored_from_resume: true } : {}),
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
    questions.map((q, i) => ({
      session_id: session.id,
      ordinal: i + 1,
      question: q.question,
      question_type: q.type,
      topic: q.topic,
      ...(q.source ? { source: q.source } : {}),
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
 *
 * The follow-up: after the first answer to a question, the interviewer may
 * ask one probing follow-up — "what is the time complexity?", "what if the
 * input is empty?" — if the answer was weak. It is stored on the round, so
 * the cap of one is a fact of the row: a round with a follow-up stored never
 * gets another, whatever the second answer looks like.
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
    .select("id, session_id, answered_at, follow_up, question_type, question")
    .eq("id", roundId)
    .maybeSingle();

  if (!round || round.session_id !== sessionId) {
    return { error: "That question is not part of this round any more. Reload the page." };
  }

  // What the round is asking right now: the follow-up if one is pending,
  // else the question. A submit for anything else is a stale retry — the
  // first answer arrived, its response did not — and must not be written
  // a second time.
  const asking = round.follow_up ?? round.question;
  if (!round.answered_at && question !== asking) {
    revalidatePath(`/session/${sessionId}`);
    return {};
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

    // First answer to this question, and no follow-up spent yet: the
    // interviewer may probe once. A stored follow-up means this submit IS the
    // follow-up answer, so the round is done either way after this.
    if (!round.follow_up) {
      const probe = await probeFor(supabase, sessionId, round, answer);
      if (probe) {
        await supabase.from("rounds").update({ follow_up: probe }).eq("id", roundId);
        revalidatePath(`/session/${sessionId}`);
        return {};
      }
    }

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

/**
 * Asks the follow-up task whether to probe. Never throws: a follow-up is a
 * nicety, and losing the brain must not lose the round. The session's level
 * is read here rather than threaded through the form, so it cannot be spoofed.
 */
async function probeFor(
  supabase: Awaited<ReturnType<typeof createClient>>,
  sessionId: string,
  round: { question_type: import("@/lib/supabase/types").QuestionType; question: string },
  answer: string,
): Promise<string | null> {
  try {
    const { data: session } = await supabase
      .from("sessions")
      .select("level")
      .eq("id", sessionId)
      .maybeSingle();
    const { probe } = await followUp({
      type: round.question_type,
      level: session?.level ?? "fresher",
      question: round.question,
      answer,
    });
    return probe;
  } catch (error) {
    console.error(`[mockprep] follow-up skipped: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
