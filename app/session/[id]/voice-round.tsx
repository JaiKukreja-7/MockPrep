"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Button, Speaker, type SpeakerHandle, type SpeakerState } from "@/components/ui";
import {
  createSttTtsTransport,
  primeSpeech,
  speak,
  stopSpeaking,
} from "@/lib/voice/stt-tts";
import { useMicrophone } from "@/lib/voice/use-microphone";
import { vlog } from "@/lib/voice/voice-log";
import type { VoiceSessionHandle } from "@/lib/voice/transport";
import type { RoundView } from "@/lib/data/session";

const transport = createSttTtsTransport();

/*
  The barge-in instrument, behind ?debug=1 and only ever outside production.
  NODE_ENV is inlined at build time, so in a production bundle this is
  `null` and the panel's module is never referenced, let alone loaded. In
  development the import is still deferred until the flag is seen.
*/
const VoiceDebugPanel =
  process.env.NODE_ENV !== "production"
    ? dynamic(
        () => import("./voice-debug-panel").then((m) => m.VoiceDebugPanel),
        { ssr: false },
      )
    : null;

function subscribeToUrl(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}

function readDebugFlag() {
  if (process.env.NODE_ENV === "production") return false;
  return new URLSearchParams(window.location.search).get("debug") === "1";
}

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
  const speakerRef = useRef<SpeakerHandle>(null);
  const spokenForRef = useRef<string | null>(null);
  // The URL flag as an external store: the server snapshot is always false,
  // so the server render is identical with or without ?debug=1 and the panel
  // appears on the client after hydration, with no setState-in-effect.
  const debug = useSyncExternalStore(
    subscribeToUrl,
    readDebugFlag,
    () => false,
  );

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
      if (spokenForRef.current === questionId) {
        vlog("question.skip", { reason: "already spoken", questionId });
        return;
      }
      vlog("question.read", { questionId, chars: question.length });
      spokenForRef.current = questionId;

      const outcome = await speak(question, {
        interrupt: false,
        onStart: () => setSpeaking(true),
        onEnd: () => setSpeaking(false),
        onBoundary: () => speakerRef.current?.pulse(),
      });

      vlog("question.outcome", { questionId, outcome });

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
     in the effect below. */
  useEffect(() => {
    void readQuestion(current.question, current.id);
  }, [current.id, current.question, readQuestion]);

  /* Round teardown: leaving the session kills the whole queue, so speech
     never carries into the next round or the report.

     Instrumented because an unmount here is indistinguishable, by ear, from
     barge-in: both stop the interviewer mid-word. If VoiceRound remounts
     across a router.refresh(), this fires and the cancel stack will say so. */
  useEffect(() => {
    vlog("voiceround.mount", {});
    return () => {
      vlog("voiceround.unmount", {});
      stopSpeaking();
    };
  }, []);

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
    vlog("record.begin", { note: "cancels any playing question" });
    stopSpeaking();
    setSpeaking(false);
    mic.startRecording();
  }, [mic]);

  const send = useCallback(async () => {
    vlog("turn.send", { roundId: current.id });
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

      vlog("turn.result", {
        done: result.done,
        ackChars: result.acknowledgement?.length ?? 0,
        nextQuestionChars: result.nextQuestion?.length ?? 0,
      });

      setRemaining(result.remainingSeconds);
      setAcknowledgement(result.acknowledgement);

      if (result.acknowledgement) {
        void speak(result.acknowledgement, {
          onStart: () => setSpeaking(true),
          onEnd: () => setSpeaking(false),
          onBoundary: () => speakerRef.current?.pulse(),
        });
      }

      if (result.done) {
        router.push(`/report/${sessionId}`);
        return;
      }

      // The next question is read by the effect once the refresh swaps
      // `current`, so the spoken text always matches the heading.
      vlog("turn.refresh", {});
      onTurnComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That turn did not go through.");
    } finally {
      setSending(false);
    }
  }, [mic, sessionId, current.id, elapsedSeconds, onTurnComplete, router]);

  /** Debug panel: a long utterance, through the same path as a question. */
  const speakTest = useCallback((text: string) => {
    primeSpeech();
    spokenForRef.current = null;
    vlog("debug.test_utterance", { chars: text.length });
    void speak(text, {
      interrupt: true,
      onStart: () => setSpeaking(true),
      onEnd: () => setSpeaking(false),
      onBoundary: () => speakerRef.current?.pulse(),
    });
  }, []);

  const recording = mic.state === "recording";

  // Priority order matters: a turn in flight outranks everything, and
  // speaking and recording cannot overlap because beginRecording cancels
  // speech first.
  const speakerState: SpeakerState = sending
    ? "thinking"
    : speaking
      ? "speaking"
      : recording
        ? "listening"
        : "idle";

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      {debug && VoiceDebugPanel ? (
        <VoiceDebugPanel arm={mic.arm} speakTest={speakTest} />
      ) : null}

      {/* The interviewer, seen. Solid is the interviewer; hollow is you being
          recorded — a split that survives prefers-reduced-motion, where the
          breathing and the rings stop but the shapes do not. */}
      <Speaker
        ref={speakerRef}
        state={speakerState}
        level={mic.level}
        className="h-24 w-40"
      />

      {acknowledgement ? (
        <p className="text-u-body" aria-live="polite">
          {acknowledgement}
        </p>
      ) : null}

      {sending ? (
        <p className="text-u-lg" aria-live="polite">
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
              {/* Same convention as the speaker at small scale: solid for the
                  interviewer, hollow for you. Not motion — shape. */}
              <span
                aria-hidden
                className={[
                  "size-2 rounded-pill border",
                  speaking
                    ? "border-accent bg-accent"
                    : recording
                      ? "border-accent bg-transparent"
                      : "border-transparent bg-transparent",
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
