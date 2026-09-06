"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import {
  createSttTtsTransport,
  primeSpeech,
  speak,
  stopSpeaking,
} from "@/lib/voice/stt-tts";
import { useMicrophone } from "@/lib/voice/use-microphone";
import type { VoiceSessionHandle } from "@/lib/voice/transport";
import type { RoundView } from "@/lib/data/session";

const transport = createSttTtsTransport();

export interface VoiceRoundProps {
  sessionId: string;
  current: RoundView;
  /** Seconds since the round began, for turn offsets. */
  elapsedSeconds: number;
  onTurnComplete: () => void;
}

/**
 * The voice control: record/stop, a level meter, barge-in, and the spoken
 * question.
 *
 * ONE question string. `current.question` is what the heading shows, what the
 * synthesiser reads, and what the server logs against this round — the model's
 * acknowledgement is spoken around it but never replaces it.
 */
export function VoiceRound({
  sessionId,
  current,
  elapsedSeconds,
  onTurnComplete,
}: VoiceRoundProps) {
  const router = useRouter();
  const mic = useMicrophone();
  const [sending, setSending] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [needsGesture, setNeedsGesture] = useState(false);
  const [acknowledgement, setAcknowledgement] = useState<string | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const handleRef = useRef<VoiceSessionHandle | null>(null);
  const spokenForRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    transport.connect(sessionId).then((h) => {
      if (!cancelled) handleRef.current = h;
    });
    return () => {
      cancelled = true;
      handleRef.current?.close();
      stopSpeaking();
    };
  }, [sessionId]);

  /**
   * Reads the current question aloud.
   *
   * `interrupt: false` so it queues behind an acknowledgement rather than
   * cutting it off, and spokenForRef stops a re-render from reading the same
   * question twice.
   */
  const readQuestion = useCallback(
    async (question: string, questionId: string) => {
      if (spokenForRef.current === questionId) return;
      spokenForRef.current = questionId;

      const outcome = await speak(question, {
        interrupt: false,
        onStart: () => setSpeaking(true),
        onEnd: () => setSpeaking(false),
      });

      // Only a silent refusal earns the prompt. "cancelled" means barge-in or
      // teardown stopped it deliberately, and audio plainly works.
      if (outcome === "blocked") {
        spokenForRef.current = null;
        setNeedsGesture(true);
      }
    },
    [],
  );

  /* Speak when the question changes.

     Deliberately no cleanup here. Returning stopSpeaking() would fire on every
     question change, and a question change is exactly the moment an
     acknowledgement is mid-sentence — it would cut its own bridge line off
     before the next question started. Cancellation belongs to teardown only,
     in the effect below.

     readQuestion only sets state from speech-event callbacks (onstart/onend)
     and from an awaited result, never synchronously during this effect; the
     lint rule cannot see through the promise. */
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void readQuestion(current.question, current.id);
  }, [current.id, current.question, readQuestion]);

  /* Round teardown: leaving the session kills the whole queue, so speech
     never carries into the next round or the report. */
  useEffect(() => () => stopSpeaking(), []);

  /** One gesture: unlocks audio, arms the mic, reads the question. */
  const enableSound = useCallback(async () => {
    primeSpeech();
    setNeedsGesture(false);
    await mic.arm();
    spokenForRef.current = null;
    void readQuestion(current.question, current.id);
  }, [mic, readQuestion, current.id, current.question]);

  const beginRecording = useCallback(async () => {
    // Arming here too, so the first tap works even if sound was already on.
    primeSpeech();
    const ok = await mic.arm();
    if (!ok) return;
    stopSpeaking();
    setSpeaking(false);
    mic.startRecording();
  }, [mic]);

  const send = useCallback(async () => {
    const captured = await mic.stopRecording();
    if (!captured) {
      setError("Nothing was recorded.");
      return;
    }

    setSending(true);
    setError(null);
    try {
      const handle = handleRef.current ?? (await transport.connect(sessionId));
      const result = await handle.sendUtterance(captured.blob, {
        roundId: current.id,
        // elapsedSeconds is already the live round clock from LiveRound, so
        // it is the offset on its own — adding time-since-mount here would
        // count the same seconds twice.
        offsetMs: Math.max(0, elapsedSeconds * 1000),
      });

      setRemaining(result.remainingSeconds);
      setAcknowledgement(result.acknowledgement);

      if (result.acknowledgement) {
        void speak(result.acknowledgement, {
          onStart: () => setSpeaking(true),
          onEnd: () => setSpeaking(false),
        });
      }

      if (result.done) {
        router.push(`/report/${sessionId}`);
        return;
      }

      // The next question is read by the effect once the refresh swaps
      // `current`, so the spoken text always matches the heading.
      onTurnComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That turn did not go through.");
    } finally {
      setSending(false);
    }
  }, [mic, sessionId, current.id, elapsedSeconds, onTurnComplete, router]);

  const recording = mic.state === "recording";

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      {acknowledgement ? (
        <p className="text-u-body" aria-live="polite">
          {acknowledgement}
        </p>
      ) : null}

      {sending ? (
        <p className="flex items-center gap-4 text-u-lg" aria-live="polite">
          <span aria-hidden className="size-2 animate-pulse rounded-pill bg-accent" />
          The interviewer is thinking…
        </p>
      ) : (
        <>
          {needsGesture ? (
            <div className="flex flex-col gap-3">
              <Button onClick={enableSound}>Let the interviewer speak</Button>
              <p className="text-u-eyebrow">
                Chrome needs one tap before it will play audio on a page.
              </p>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-6">
            <Button
              onClick={() => (recording ? send() : beginRecording())}
              disabled={mic.state === "requesting" || mic.state === "denied"}
            >
              {recording ? "Stop and send" : "Start recording"}
            </Button>

            <p className="flex items-center gap-3 text-u-eyebrow" aria-live="polite">
              <span
                aria-hidden
                className={[
                  "size-2 rounded-pill",
                  speaking || recording ? "bg-accent" : "bg-transparent",
                  speaking ? "animate-pulse" : "",
                ].join(" ")}
              />
              {speaking
                ? "The interviewer is speaking"
                : mic.bargedIn
                  ? "You cut in — go ahead"
                  : micLabel(mic.state)}
            </p>
          </div>

          {/* Level meter: the same 1px rule + 2px bar the score meters use,
              so the one moving thing on screen still reads as the system. */}
          <div
            className="relative w-full max-w-md border-b border-b-rule pt-6"
            role="meter"
            aria-label="Microphone level"
            aria-valuenow={Math.round(mic.level * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span
              aria-hidden
              className="link-bar absolute left-0 -bottom-px transition-[width] duration-75"
              style={{ width: `${Math.round(mic.level * 100)}%` }}
            />
          </div>
        </>
      )}

      {remaining !== null ? (
        <p className="text-u-micro">
          <span className="numeric">{Math.floor(remaining / 60)}</span> min of
          round time left
        </p>
      ) : null}

      {(error ?? mic.error) ? (
        <p className="text-u-eyebrow text-error" role="alert">
          {error ?? mic.error}
        </p>
      ) : null}
    </div>
  );
}

function micLabel(state: string) {
  if (state === "recording") return "Listening";
  if (state === "requesting") return "Asking for the microphone";
  if (state === "denied") return "Microphone blocked";
  if (state === "armed") return "Microphone on";
  return "Microphone idle";
}
