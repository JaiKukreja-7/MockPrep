import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { OUTAGE_MESSAGE } from "@/lib/supabase/outage";
import { currentUser } from "@/lib/supabase/user";
import { describeLlmFailure } from "@/lib/llm/user-message";
import { transcribe } from "@/lib/llm/tasks/transcribe";
import { interviewerTurn } from "@/lib/llm/tasks/interviewer-turn";
import { scoreSession } from "@/lib/rounds/score";
import type { VoiceTurnResult } from "@/lib/voice/transport";

// Whisper, the interviewer's bridge line and — on the last turn — the whole
// scoring pipeline, each with a backoff ladder behind it. 300 is the Vercel
// ceiling with Fluid compute on the Hobby and Pro plans.
export const maxDuration = 300;

/** Hard ceiling for one round, enforced here and not in the browser. */
const MAX_ROUND_MS = 10 * 60 * 1000;

export async function POST(request: NextRequest) {
  const supabase = await createClient();

  const { user, outage } = await currentUser(supabase);
  if (outage) {
    return NextResponse.json({ error: OUTAGE_MESSAGE }, { status: 503 });
  }
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  // Voice needs a real account. RLS blocks a guest from writing a voice round
  // regardless, but failing here gives an explainable message rather than a
  // policy violation surfacing as a generic insert error.
  const { data: profile } = await supabase
    .from("users")
    .select("is_guest")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile || profile.is_guest) {
    return NextResponse.json(
      { error: "Voice rounds need an account. Guests get text mode." },
      { status: 403 },
    );
  }

  const form = await request.formData();
  const sessionId = String(form.get("sessionId") ?? "");
  const roundId = String(form.get("roundId") ?? "");
  const offsetMs = Number(form.get("offsetMs") ?? 0) || 0;
  const audio = form.get("audio");

  if (!sessionId || !roundId || !(audio instanceof Blob)) {
    return NextResponse.json({ error: "Malformed turn." }, { status: 400 });
  }

  const { data: round } = await supabase
    .from("rounds")
    .select("id, ordinal, question, session_id")
    .eq("id", roundId)
    .maybeSingle();

  if (!round || round.session_id !== sessionId) {
    return NextResponse.json({ error: "Unknown round." }, { status: 404 });
  }

  /* ------------------------------------------------ round-length ceiling */
  const { data: spoken } = await supabase
    .from("transcripts")
    .select("start_ms, end_ms")
    .eq("session_id", sessionId)
    .eq("speaker", "candidate");

  const alreadyMs = (spoken ?? []).reduce(
    (sum, l) =>
      sum + Math.max(0, (l.end_ms ?? 0) - (l.start_ms ?? 0)),
    0,
  );

  if (alreadyMs >= MAX_ROUND_MS) {
    const outcome = await scoreSession(sessionId, Math.round(offsetMs / 1000));
    return NextResponse.json({
      lines: [],
      acknowledgement: "That is ten minutes — the round stops there.",
      nextQuestion: null,
      remainingSeconds: 0,
      done: outcome.ok,
      scoringFailed: !outcome.ok,
      error: outcome.ok ? undefined : outcome.error,
    } satisfies VoiceTurnResult);
  }

  /* ---------------------------------------------------------------- STT */
  let text: string;
  let durationMs: number;
  try {
    ({ text, durationMs } = await transcribe(audio));
  } catch (error) {
    // The Whisper error body is a JSON blob; it goes to the log, and the
    // screen gets a sentence. The recording is still on the client.
    return NextResponse.json(
      {
        error: describeLlmFailure(
          error,
          "Could not transcribe that",
          "The recording is still here — send it again in a moment.",
        ),
      },
      { status: 502 },
    );
  }

  if (!text) {
    return NextResponse.json(
      { error: "Nothing was picked up — try again a bit closer to the mic." },
      { status: 422 },
    );
  }

  // Meter against the daily voice budget. Granted may be less than asked,
  // which is what cuts a long day short rather than refusing outright.
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  const { data: meter } = await supabase.rpc("consume_voice_seconds", {
    p_seconds: seconds,
  });
  const grant = Array.isArray(meter) ? meter[0] : meter;
  if (grant && !grant.allowed) {
    return NextResponse.json(
      {
        error: `Daily voice limit reached — ${grant.used} of ${grant.cap} seconds used.`,
      },
      { status: 429 },
    );
  }

  /* -------------------------------------------- persist what was said */
  const lines = [
    {
      session_id: sessionId,
      round_id: roundId,
      at_seconds: Math.max(0, Math.round(offsetMs / 1000) - 1),
      speaker: "interviewer" as const,
      body: round.question,
      start_ms: Math.max(0, offsetMs - 1),
      end_ms: Math.max(0, offsetMs),
    },
    {
      session_id: sessionId,
      round_id: roundId,
      at_seconds: Math.round(offsetMs / 1000),
      speaker: "candidate" as const,
      body: text,
      start_ms: offsetMs,
      end_ms: offsetMs + durationMs,
    },
  ];

  const { error: writeError } = await supabase.from("transcripts").insert(lines);
  if (writeError) {
    return NextResponse.json({ error: writeError.message }, { status: 500 });
  }

  await supabase
    .from("rounds")
    .update({ answered_at: new Date().toISOString() })
    .eq("id", roundId);

  /* ----------------------------------------------------- next question */
  const { data: remaining } = await supabase
    .from("rounds")
    .select("id, ordinal, question")
    .eq("session_id", sessionId)
    .is("answered_at", null)
    .order("ordinal", { ascending: true })
    .limit(1);

  const next = remaining?.[0] ?? null;

  // The bridge is a nicety; the question is not. Losing the brain must never
  // lose or alter the question, so they travel as separate fields.
  let acknowledgement: string | null = null;
  try {
    ({ text: acknowledgement } = await interviewerTurn({
      question: round.question,
      answer: text,
      isLast: !next,
    }));
  } catch {
    acknowledgement = null;
  }

  const remainingSeconds = Math.max(
    0,
    Math.round((MAX_ROUND_MS - alreadyMs - durationMs) / 1000),
  );

  if (!next) {
    const outcome = await scoreSession(sessionId, Math.round((offsetMs + durationMs) / 1000));
    return NextResponse.json({
      lines: lines.map((l) => ({
        speaker: l.speaker,
        text: l.body,
        startMs: l.start_ms,
        endMs: l.end_ms,
      })),
      acknowledgement,
      nextQuestion: null,
      remainingSeconds,
      done: outcome.ok,
      scoringFailed: !outcome.ok,
      error: outcome.ok ? undefined : outcome.error,
    } satisfies VoiceTurnResult);
  }

  return NextResponse.json({
    lines: lines.map((l) => ({
      speaker: l.speaker,
      text: l.body,
      startMs: l.start_ms,
      endMs: l.end_ms,
    })),
    acknowledgement,
    // Verbatim from the database — never the model's rendering of it.
    nextQuestion: next.question,
    remainingSeconds,
    done: false,
  } satisfies VoiceTurnResult);
}
