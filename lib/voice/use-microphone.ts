"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isSpeaking, msSinceSpeechStart, stopSpeaking } from "./stt-tts";
import { vlog } from "./voice-log";

export type MicState =
  | "idle"
  | "requesting"
  | "armed"
  | "recording"
  | "denied";

/* ===========================================================================
   BARGE-IN DETECTION
   ---------------------------------------------------------------------------
   The previous version used a fixed 0.06 RMS threshold and three consecutive
   frames. Both were wrong, and a captured trace showed why: a real room's
   idle floor peaked 0.06–0.19, so the threshold sat *below* ambient noise,
   and three frames at 60fps is ~50ms — short enough that the synthesiser's
   own onset, leaking past echo cancellation, tripped it. Questions died
   within 400ms of starting, with nobody in the room speaking.

   So: nothing here is a guessed constant against an absolute level. The
   threshold is derived from the room, and again from the echo, and a
   decision needs sustained evidence rather than a handful of frames.
   =========================================================================== */

/** Idle floor is measured over this long after arming, before anything speaks. */
const CALIBRATION_MS = 2000;
/**
 * Speech has to clear the room's own p95 by this much.
 *
 * Deliberately not higher: modelled against the captured trace, a 2.2x idle
 * multiplier with a noisy room (p95 0.19) put the speaking bar at 0.63 RMS,
 * which is above ordinary talking — barge-in would have gone from twitchy to
 * deaf. At 1.8 the bar still sits 2.6-4.9x above the observed false fires.
 */
const IDLE_MULTIPLIER = 1.8;
/** A floor so low it must be a near-silent room; guards against over-eager firing. */
const MIN_THRESHOLD = 0.08;
/** While the interviewer talks, the bar rises: interrupting is a deliberate act. */
const SPEAKING_BOOST = 1.35;
/** …and it must also clear the measured echo, not just the idle floor. */
const ECHO_MULTIPLIER = 1.8;
/**
 * No barge-in in the first moments of a chunk. The onset is the loudest part
 * of the echo, and two of three false fires in the captured trace landed
 * inside 400ms of a chunk starting.
 */
const GUARD_MS = 700;
/** Decision window. Sustained speech, not a spike. */
const WINDOW_MS = 600;
/** Share of the window that must be over threshold. */
const WINDOW_RATIO = 0.6;
/** Never decide on a handful of samples. */
const MIN_WINDOW_FRAMES = 15;

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[index];
}

export interface UseMicrophone {
  state: MicState;
  /** 0..1, smoothed. Drives the level meter. */
  level: number;
  error: string | null;
  /** True when the candidate's voice has just cut the interviewer off. */
  bargedIn: boolean;
  /**
   * Opens the stream and starts metering. Separate from recording so the
   * analyser — and therefore barge-in — runs while the interviewer talks,
   * not only while the candidate is being recorded.
   */
  arm(): Promise<boolean>;
  startRecording(): void;
  stopRecording(): Promise<{ blob: Blob; durationMs: number } | null>;
  release(): void;
}

export function useMicrophone(): UseMicrophone {
  const [state, setState] = useState<MicState>("idle");
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [bargedIn, setBargedIn] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);

  const teardown = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    setLevel(0);
  }, []);

  useEffect(() => teardown, [teardown]);

  const arm = useCallback(async () => {
    if (streamRef.current) return true;

    setError(null);
    setState("requesting");

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Echo cancellation is necessary but demonstrably not sufficient:
          // the captured trace had it on and still leaked enough of the
          // synthesiser to cross a fixed threshold.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch {
      setState("denied");
      setError("Microphone access was blocked. Allow it, or switch to text mode.");
      return false;
    }

    streamRef.current = stream;
    const track = stream.getAudioTracks()[0];
    vlog("mic.armed", {
      label: track?.label ?? "unknown",
      settings: JSON.stringify(track?.getSettings?.() ?? {}),
    });

    const ctx = new AudioContext();
    audioCtxRef.current = ctx;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);

    const buffer = new Float32Array(analyser.fftSize);
    let smoothed = 0;

    /* ---- calibration state ---- */
    const armedAt = performance.now();
    const idleSamples: number[] = [];
    let idleThreshold = MIN_THRESHOLD;
    let calibrated = false;

    /* ---- echo state: what the mic hears of our own voice ---- */
    const echoSamples: number[] = [];

    /* ---- rolling decision window ---- */
    let windowFrames: Array<{ t: number; over: boolean }> = [];
    let lastSuppressLog = 0;
    let lastSpeechLog = 0;

    /* ---- level reporting ---- */
    let reportStart = performance.now();
    let reportPeak = 0;
    let reportSum = 0;
    let reportCount = 0;
    let reportSpeakingFrames = 0;

    const tick = () => {
      analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (const sample of buffer) sum += sample * sample;
      const rms = Math.sqrt(sum / buffer.length);
      const synthTalking = isSpeaking();
      const now = performance.now();

      smoothed = smoothed * 0.8 + rms * 0.2;
      setLevel(Math.min(1, smoothed * 6));

      /* ---------------------------------------------------- calibration */
      if (!calibrated) {
        // Only quiet frames count: a question playing during calibration
        // would bake the echo into the "room" floor.
        if (!synthTalking) idleSamples.push(rms);
        if (now - armedAt >= CALIBRATION_MS) {
          const floor = percentile(idleSamples, 0.95);
          idleThreshold = Math.max(MIN_THRESHOLD, floor * IDLE_MULTIPLIER);
          calibrated = true;
          vlog("mic.calibrated", {
            samples: idleSamples.length,
            floorP50: percentile(idleSamples, 0.5),
            floorP95: floor,
            idleThreshold,
            speakingThresholdBase: idleThreshold * SPEAKING_BOOST,
          });
        }
      }

      /* ------------------------------------------------------ echo floor
         Sampled only inside the guard window, where we know any level is
         our own output rather than an interruption. */
      const sinceChunkStart = msSinceSpeechStart();
      const inGuard = synthTalking && sinceChunkStart < GUARD_MS;
      if (inGuard) {
        echoSamples.push(rms);
        if (echoSamples.length > 400) echoSamples.shift();
      }
      const echoFloor =
        echoSamples.length >= 15 ? percentile(echoSamples, 0.95) : 0;

      const threshold = synthTalking
        ? Math.max(idleThreshold * SPEAKING_BOOST, echoFloor * ECHO_MULTIPLIER)
        : idleThreshold;

      /* -------------------------------------------------- rolling window */
      windowFrames.push({ t: now, over: rms > threshold });
      while (windowFrames.length > 0 && now - windowFrames[0].t > WINDOW_MS) {
        windowFrames.shift();
      }
      const overCount = windowFrames.reduce((n, f) => n + (f.over ? 1 : 0), 0);
      const ratio =
        windowFrames.length > 0 ? overCount / windowFrames.length : 0;
      const sustained =
        windowFrames.length >= MIN_WINDOW_FRAMES && ratio >= WINDOW_RATIO;

      /* -------------------------------------------------------- reporting */
      reportPeak = Math.max(reportPeak, rms);
      reportSum += rms;
      reportCount += 1;
      if (synthTalking) reportSpeakingFrames += 1;
      if (now - reportStart >= 250) {
        vlog("mic.level", {
          peak: reportPeak,
          avg: reportSum / Math.max(1, reportCount),
          threshold,
          echoFloor,
          overThreshold: reportPeak > threshold,
          ratio,
          synthSpeakingFrames: reportSpeakingFrames,
          frames: reportCount,
        });
        reportStart = now;
        reportPeak = 0;
        reportSum = 0;
        reportCount = 0;
        reportSpeakingFrames = 0;
      }

      /* ---------------------------------------------------------- decide
         Sustained speech while nothing is playing is logged as the control
         case: it is the evidence that the bar is reachable by a real voice.
         If a trace shows questions no longer cut off but never shows
         speech.detected either, the threshold has gone from twitchy to deaf
         and IDLE_MULTIPLIER wants lowering. */
      if (!synthTalking && sustained && calibrated && now - lastSpeechLog > 1000) {
        lastSpeechLog = now;
        vlog("speech.detected", {
          rms,
          threshold,
          ratio,
          note: "would have barged in if the interviewer were talking",
        });
      }

      if (synthTalking && sustained && calibrated) {
        if (inGuard) {
          // Sustained, but too soon after onset to trust. Log sparsely.
          if (now - lastSuppressLog > 500) {
            lastSuppressLog = now;
            vlog("bargein.suppressed", {
              reason: "guard window",
              msSinceChunkStart: Math.round(sinceChunkStart),
              guardMs: GUARD_MS,
              rms,
              threshold,
              ratio,
            });
          }
        } else {
          vlog("bargein.fire", {
            rms,
            threshold,
            echoFloor,
            idleThreshold,
            ratio,
            windowFrames: windowFrames.length,
            msSinceChunkStart: Math.round(sinceChunkStart),
          });
          stopSpeaking();
          setBargedIn(true);
          setTimeout(() => setBargedIn(false), 1500);
          // Clear the window so one burst cannot fire twice.
          windowFrames = [];
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    setState("armed");
    return true;
  }, []);

  const startRecording = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;

    chunksRef.current = [];
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorderRef.current = recorder;
    recorder.start();
    startedAtRef.current = Date.now();
    vlog("mic.record.start", {});
    setState("recording");
  }, []);

  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") {
      setState(streamRef.current ? "armed" : "idle");
      return null;
    }

    const done = new Promise<Blob>((resolve) => {
      recorder.onstop = () =>
        resolve(new Blob(chunksRef.current, { type: recorder.mimeType }));
    });
    recorder.stop();
    const blob = await done;
    const durationMs = Date.now() - startedAtRef.current;
    vlog("mic.record.stop", { durationMs, bytes: blob.size });

    recorderRef.current = null;
    // The stream stays open so the meter and barge-in keep working while the
    // interviewer replies.
    setState("armed");
    return blob.size > 0 ? { blob, durationMs } : null;
  }, []);

  const release = useCallback(() => {
    teardown();
    setState("idle");
  }, [teardown]);

  return {
    state,
    level,
    error,
    bargedIn,
    arm,
    startRecording,
    stopRecording,
    release,
  };
}
