"use client";

import { useActionState, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button, PillTag, RuledRow, RuledRowList } from "@/components/ui";
import { submitAnswer, type ActionState } from "@/app/rounds/actions";
import { describeSubmitFailure } from "@/lib/client-errors";
import type { SessionView } from "@/lib/data/session";
import { ScoreRetry } from "./score-retry";
import { VoiceRound } from "./voice-round";

interface SubmitState extends ActionState {
  /** The failure needs a fresh session; show the sign-in link. */
  signIn?: boolean;
}

function formatClock(total: number) {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function LiveRound({ view }: { view: SessionView }) {
  const { session, rounds, transcript, current } = view;

  const router = useRouter();
  const isVoice = current?.mode === "voice";
  const [running, setRunning] = useState(true);
  const [elapsed, setElapsed] = useState(view.elapsedSeconds);
  // The action call is wrapped so a request that never arrives — the network
  // dropped, the session expired and the proxy redirected the POST — comes
  // back as a sentence in this form rather than an exception that unmounts
  // it. The typed answer is React state, not an uncontrolled field, for the
  // same reason: it must survive the failure.
  const [state, formAction, pending] = useActionState<SubmitState, FormData>(
    async (prev, formData) => {
      try {
        return await submitAnswer(prev, formData);
      } catch (error) {
        const failure = describeSubmitFailure(error, "answer");
        return { error: failure.message, signIn: failure.signIn };
      }
    },
    {},
  );
  const [answer, setAnswer] = useState("");
  const answeredRef = useRef(current?.id);

  useEffect(() => {
    if (!running || pending) return;
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [running, pending]);

  // A new question means the previous answer submitted; clear the box. On a
  // failure the question is the same one, so the answer stays.
  if (answeredRef.current !== current?.id) {
    answeredRef.current = current?.id;
    if (answer) setAnswer("");
  }

  const clock = formatClock(elapsed);
  const answered = rounds.filter((r) => r.answered).length;

  // Voice turns are posted by VoiceRound, so the page needs a refresh to pick
  // up the persisted transcript and advance to the next question.
  const onTurnComplete = useCallback(() => router.refresh(), [router]);

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex h-[72px] shrink-0 items-center justify-between gap-6 border-b border-b-rule px-8">
        <div className="flex min-w-0 items-center gap-6">
          <span className="display text-u-body shrink-0">
            MockPrep<sup>®</sup>
          </span>
          <span className="eyebrow truncate">{session.title}</span>
          <span className="hidden sm:block">
            <PillTag>{session.track}</PillTag>
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-6">
          <p className="flex items-center gap-3">
            <span
              aria-hidden
              className={[
                "size-2 rounded-pill",
                running && !pending ? "bg-accent" : "bg-transparent",
              ].join(" ")}
            />
            <span className="numeric text-u-lg" aria-label={`Elapsed ${clock}`}>
              {clock}
            </span>
          </p>
          {isVoice ? (
            <span className="eyebrow">Voice</span>
          ) : (
            <Button
              variant="outline"
              size="compact"
              onClick={() => setRunning((r) => !r)}
              disabled={pending}
            >
              {running ? "Pause round" : "Resume round"}
            </Button>
          )}
        </div>
      </header>

      <main className="flex flex-1 flex-col">
        <section className="px-8 pt-12 pb-10">
          <p className="eyebrow">
            {current
              ? `Question ${Math.min(answered + 1, rounds.length)} of ${rounds.length}`
              : "Round complete"}
          </p>
          <h1 className="display text-u-display mt-4 max-w-4xl">
            {current?.question ?? "Every question is answered."}
          </h1>
        </section>

        <section className="px-8 pb-16">
          {isVoice && current ? (
            <VoiceRound
              sessionId={session.id}
              current={current}
              elapsedSeconds={elapsed}
              onTurnComplete={onTurnComplete}
            />
          ) : pending ? (
            /* The queue can hold a request through four backoff steps and a
               failover, so this has to be visible or the round looks broken. */
            <p className="flex items-center gap-4 text-u-lg" aria-live="polite">
              <span
                aria-hidden
                className="size-2 animate-pulse rounded-pill bg-accent"
              />
              The interviewer is thinking…
            </p>
          ) : !current && rounds.length > 0 ? (
            /* Every round answered, session still live: the last submit's
               scoring did not go through. The answers are saved; this is the
               way to the score. Never a blank end. */
            <ScoreRetry sessionId={session.id} why={state.error} />
          ) : current ? (
            <form action={formAction} className="flex max-w-4xl flex-col gap-6">
              <input type="hidden" name="sessionId" value={session.id} />
              <input type="hidden" name="roundId" value={current.id} />
              <input type="hidden" name="question" value={current.question} />
              <input type="hidden" name="elapsed" value={elapsed} />

              <label className="flex flex-col gap-2">
                <span className="eyebrow">Your answer</span>
                <textarea
                  name="answer"
                  rows={6}
                  required
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                  className="input h-auto rounded-surface py-4 leading-normal"
                  placeholder="Talk through it the way you would out loud."
                />
              </label>

              {state.error ? (
                <p className="text-u-eyebrow text-error" role="alert">
                  {state.error}
                  {state.signIn ? (
                    <>
                      {" "}
                      <Link href="/sign-in" target="_blank" rel="noopener" className="font-medium">
                        Sign in in a new tab
                      </Link>
                    </>
                  ) : null}
                </p>
              ) : null}

              <div>
                <Button type="submit">
                  {answered === rounds.length - 1
                    ? "Submit and finish"
                    : "Submit answer"}
                </Button>
              </div>
            </form>
          ) : null}
        </section>

        <section className="px-8 pb-16">
          <h2 className="eyebrow mb-4">Transcript</h2>
          {transcript.length > 0 ? (
            <RuledRowList>
              {transcript.map((line) => (
                <RuledRow
                  key={line.id}
                  className="py-8"
                  scale="ui"
                  title={line.body}
                  meta={
                    <>
                      <time>{formatClock(line.at_seconds)}</time>{" "}
                      <span aria-hidden>·</span>{" "}
                      {line.speaker === "interviewer" ? "Interviewer" : "You"}
                    </>
                  }
                />
              ))}
            </RuledRowList>
          ) : (
            <RuledRowList>
              <RuledRow
                className="py-8"
                scale="ui"
                title="Nothing said yet."
                meta="Your answers appear here as you submit them"
              />
            </RuledRowList>
          )}
        </section>
      </main>
    </div>
  );
}
