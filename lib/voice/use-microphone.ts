"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isSpeaking, stopSpeaking } from "./stt-tts";
import { vlog } from "./voice-log";

export type MicState =
  | "idle"
  | "requesting"
  | "armed"
  | "recording"
  | "denied";

/** Above this RMS the candidate is considered to be talking, not room noise. */
const BARGE_IN_LEVEL = 0.06;
/** Sustained frames over the threshold before we call it speech. */
const BARGE_IN_FRAMES = 3;

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
  const loudFramesRef = useRef(0);

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
          // Without echo cancellation the synthesiser's own voice comes back
          // through the mic and trips barge-in against itself.
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
      // If echoCancellation reads false here, the synthesiser's own voice is
      // going straight back into the analyser.
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

    // Rolling summary of what the mic hears while the synthesiser talks. If
    // echo cancellation is failing, the peak here climbs above the barge-in
    // threshold with nobody in the room speaking.
    let windowStart = performance.now();
    let windowPeak = 0;
    let windowSum = 0;
    let windowFrames = 0;
    let windowWhileSpeaking = 0;

    const tick = () => {
      analyser.getFloatTimeDomainData(buffer);
      let sum = 0;
      for (const sample of buffer) sum += sample * sample;
      const rms = Math.sqrt(sum / buffer.length);
      const synthTalking = isSpeaking();

      // Smoothed so the meter reads as a level rather than a strobe.
      smoothed = smoothed * 0.8 + rms * 0.2;
      setLevel(Math.min(1, smoothed * 6));

      windowPeak = Math.max(windowPeak, rms);
      windowSum += rms;
      windowFrames += 1;
      if (synthTalking) windowWhileSpeaking += 1;

      const now = performance.now();
      if (now - windowStart >= 250) {
        vlog("mic.level", {
          peak: windowPeak,
          avg: windowSum / Math.max(1, windowFrames),
          threshold: BARGE_IN_LEVEL,
          overThreshold: windowPeak > BARGE_IN_LEVEL,
          synthSpeakingFrames: windowWhileSpeaking,
          frames: windowFrames,
        });
        windowStart = now;
        windowPeak = 0;
        windowSum = 0;
        windowFrames = 0;
        windowWhileSpeaking = 0;
      }

      // Barge-in. Requiring consecutive loud frames keeps a cough or a door
      // from cutting the interviewer off mid-question.
      if (rms > BARGE_IN_LEVEL) {
        loudFramesRef.current += 1;
        if (loudFramesRef.current >= BARGE_IN_FRAMES && synthTalking) {
          vlog("bargein.fire", {
            rms,
            threshold: BARGE_IN_LEVEL,
            loudFrames: loudFramesRef.current,
            needed: BARGE_IN_FRAMES,
            synthSpeaking: true,
          });
          stopSpeaking();
          setBargedIn(true);
          setTimeout(() => setBargedIn(false), 1500);
        } else if (loudFramesRef.current === BARGE_IN_FRAMES && !synthTalking) {
          // Loud enough to have fired, but nothing was playing. Useful as the
          // control case: it shows the threshold being crossed by real speech.
          vlog("bargein.armed_silent", {
            rms,
            loudFrames: loudFramesRef.current,
          });
        }
      } else {
        loudFramesRef.current = 0;
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
