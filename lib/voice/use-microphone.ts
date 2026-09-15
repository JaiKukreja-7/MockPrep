"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isSpeaking, msSinceSpeechStart, stopSpeaking } from "./stt-tts";
import { vlog } from "./voice-log";
import {
  EMPTY_SNAPSHOT,
  getTuning,
  publishSnapshot,
  takeRecalibrationRequest,
  thresholdsFor,
} from "./barge-in-tuning";

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
/** Decision window. Sustained speech, not a spike. */
const WINDOW_MS = 600;
/** Never decide on a handful of samples. */
const MIN_WINDOW_FRAMES = 15;
/*
   The four values that have been re-guessed most — the idle and echo
   multipliers, the guard, the window ratio — live in ./barge-in-tuning with
   their rationale, and are read by the tick every frame rather than fixed
   here, so the debug panel can move them while a question is playing. */

/** In order of preference. Whisper accepts all three. */
const RECORDER_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

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
    publishSnapshot(EMPTY_SNAPSHOT);
  }, []);

  useEffect(() => teardown, [teardown]);

  const arm = useCallback(async () => {
    if (streamRef.current) return true;

    setError(null);
    setState("requesting");

    // iOS Safari: an AudioContext created after an await has lost the user
    // gesture and starts suspended — the analyser then reads zeros forever,
    // which kills the level meter, calibrates the noise floor at silence,
    // and leaves barge-in deaf. Create it synchronously, first thing, while
    // the click that called arm() still counts as activation.
    const ctx = new AudioContext();
    audioCtxRef.current = ctx;

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
      ctx.close().catch(() => {});
      audioCtxRef.current = null;
      setState("denied");
      setError("Microphone access was blocked. Allow it, or switch to text mode.");
      return false;
    }

    // Belt and braces for the same iOS rule: resume() is a no-op elsewhere
    // and the state is logged so a silent meter can be traced to this line.
    if (ctx.state !== "running") await ctx.resume().catch(() => {});

    streamRef.current = stream;
    const track = stream.getAudioTracks()[0];
    vlog("mic.armed", {
      label: track?.label ?? "unknown",
      audioContextState: ctx.state,
      settings: JSON.stringify(track?.getSettings?.() ?? {}),
    });

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);

    const buffer = new Float32Array(analyser.fftSize);
    let smoothed = 0;

    /* ---- calibration state ---- */
    let armedAt = performance.now();
    let idleSamples: number[] = [];
    let floorP95 = 0;
    let calibrated = false;

    /* ---- echo state: what the mic hears of our own voice ---- */
    let echoSamples: number[] = [];

    /* ---- control-case and fire timestamps, for the panel ---- */
    let speechDetectedAt = 0;
    let firedAt = 0;

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
      const tuning = getTuning();

      smoothed = smoothed * 0.8 + rms * 0.2;
      setLevel(Math.min(1, smoothed * 6));

      /* ---------------------------------------------------- calibration */
      if (takeRecalibrationRequest()) {
        armedAt = now;
        idleSamples = [];
        echoSamples = [];
        floorP95 = 0;
        calibrated = false;
        windowFrames = [];
        vlog("mic.recalibrate", {});
      }
      if (!calibrated) {
        // Only quiet frames count: a question playing during calibration
        // would bake the echo into the "room" floor.
        if (!synthTalking) idleSamples.push(rms);
        if (now - armedAt >= CALIBRATION_MS) {
          floorP95 = percentile(idleSamples, 0.95);
          calibrated = true;
          const t = thresholdsFor(floorP95, 0, tuning);
          vlog("mic.calibrated", {
            samples: idleSamples.length,
            floorP50: percentile(idleSamples, 0.5),
            floorP95,
            idleThreshold: t.idle,
            speakingThresholdBase: t.speaking,
          });
        }
      }
      /* ------------------------------------------------------ echo floor
         Sampled only inside the guard window, where we know any level is
         our own output rather than an interruption. */
      const sinceChunkStart = msSinceSpeechStart();
      const inGuard = synthTalking && sinceChunkStart < tuning.guardMs;
      if (inGuard) {
        echoSamples.push(rms);
        if (echoSamples.length > 400) echoSamples.shift();
      }
      const echoFloor =
        echoSamples.length >= 15 ? percentile(echoSamples, 0.95) : 0;

      // Derived every frame, not once at calibration, so a multiplier moved
      // in the panel changes the bar on the next frame.
      const { idle: idleThreshold, speaking: speakingThreshold } = thresholdsFor(
        floorP95,
        echoFloor,
        tuning,
      );
      const threshold = synthTalking ? speakingThreshold : idleThreshold;

      /* -------------------------------------------------- rolling window */
      windowFrames.push({ t: now, over: rms > threshold });
      while (windowFrames.length > 0 && now - windowFrames[0].t > WINDOW_MS) {
        windowFrames.shift();
      }
      const overCount = windowFrames.reduce((n, f) => n + (f.over ? 1 : 0), 0);
      const ratio =
        windowFrames.length > 0 ? overCount / windowFrames.length : 0;
      const sustained =
        windowFrames.length >= MIN_WINDOW_FRAMES && ratio >= tuning.windowRatio;

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
         and idleMultiplier wants lowering. */
      if (!synthTalking && sustained && calibrated) speechDetectedAt = now;
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
              guardMs: tuning.guardMs,
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
          firedAt = now;
          stopSpeaking();
          setBargedIn(true);
          setTimeout(() => setBargedIn(false), 1500);
          // Clear the window so one burst cannot fire twice.
          windowFrames = [];
        }
      }

      /* ---------------------------------------------------------- publish
         Every number the decision rested on, for the debug panel. */
      publishSnapshot({
        at: now,
        live: true,
        rms,
        smoothed,
        calibrated,
        calibrationMsLeft: calibrated ? 0 : Math.max(0, CALIBRATION_MS - (now - armedAt)),
        floorP95,
        idleThreshold,
        echoFloor,
        echoSamples: echoSamples.length,
        speakingThreshold,
        threshold,
        synthSpeaking: synthTalking,
        inGuard,
        msSinceChunkStart: synthTalking ? sinceChunkStart : 0,
        windowRatio: ratio,
        windowFrames: windowFrames.length,
        sustained,
        speechDetectedAt,
        firedAt,
      });

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
    // Chrome records WebM/Opus; iOS Safari has no WebM and records MP4/AAC.
    // Ask for the first the browser supports rather than assuming, and let
    // the transport name the file from what actually came back.
    const mimeType = RECORDER_TYPES.find((t) => MediaRecorder.isTypeSupported(t));
    const recorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);
    vlog("mic.recorder", { mimeType: recorder.mimeType || "(default)" });
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
