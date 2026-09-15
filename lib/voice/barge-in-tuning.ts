"use client";

/**
 * The barge-in detector's tunables and its live telemetry.
 *
 * Two console traces produced three wrong diagnoses, because a trace is read
 * after the fact and the numbers that matter — the room floor, the echo
 * floor, the rolling-window fill — were locals inside the analyser tick. This
 * module lifts them out: the tick reads its multipliers from here every frame
 * (so a slider moves the bar while a question is playing, no reload) and
 * writes a snapshot here every frame (so a panel can show the bar and the
 * level against it, live). The `__voiceLog` ring buffer is untouched; this
 * is a faster surface over the same detector, not a second one.
 *
 * Everything here is plain module state, deliberately: the tick runs inside
 * requestAnimationFrame and must not go through React to read a number.
 */

/* ------------------------------------------------------------ tuning ---- */

export interface Tuning {
  /**
   * Speech has to clear the room's own p95 by this much.
   *
   * Deliberately not higher: modelled against the captured trace, a 2.2x
   * idle multiplier with a noisy room (p95 0.19) put the speaking bar at 0.63
   * RMS, which is above ordinary talking — barge-in would have gone from
   * twitchy to deaf. At 1.8 the bar still sits 2.6–4.9x above the observed
   * false fires.
   */
  idleMultiplier: number;
  /** While the interviewer talks the level must also clear the measured echo by this much. */
  echoMultiplier: number;
  /**
   * No barge-in in the first moments of a chunk. The onset is the loudest
   * part of the echo, and two of three false fires in the captured trace
   * landed inside 400ms of a chunk starting.
   */
  guardMs: number;
  /** Share of the rolling window that must be over threshold to count as sustained. */
  windowRatio: number;
}

/* Not tunable — fixed parts of the same formula, kept here so the panel's
   preview and the tick's decision are computed from the same numbers. */

/** A floor so low it must be a near-silent room; guards against over-eager firing. */
export const MIN_THRESHOLD = 0.08;
/** While the interviewer talks, the bar rises: interrupting is a deliberate act. */
export const SPEAKING_BOOST = 1.35;

/** The two thresholds from the measured floors and the current tuning. */
export function thresholdsFor(floorP95: number, echoFloor: number, t: Readonly<Tuning>) {
  const idle = Math.max(MIN_THRESHOLD, floorP95 * t.idleMultiplier);
  const speaking = Math.max(idle * SPEAKING_BOOST, echoFloor * t.echoMultiplier);
  return { idle, speaking };
}

export const DEFAULT_TUNING: Readonly<Tuning> = Object.freeze({
  idleMultiplier: 1.8,
  echoMultiplier: 1.8,
  guardMs: 700,
  windowRatio: 0.6,
});

let tuning: Tuning = { ...DEFAULT_TUNING };
const tuningListeners = new Set<() => void>();

export function getTuning(): Readonly<Tuning> {
  return tuning;
}

export function setTuning(patch: Partial<Tuning>): void {
  tuning = { ...tuning, ...patch };
  for (const fn of tuningListeners) fn();
}

export function resetTuning(): void {
  setTuning({ ...DEFAULT_TUNING });
}

export function onTuningChange(fn: () => void): () => void {
  tuningListeners.add(fn);
  return () => tuningListeners.delete(fn);
}

/* --------------------------------------------------------- telemetry ---- */

export interface DetectorSnapshot {
  /** performance.now() of the frame. */
  at: number;
  /** True once a microphone is armed and the tick is running. */
  live: boolean;
  /** Raw RMS this frame. */
  rms: number;
  /** Smoothed RMS — what the level meter shows. */
  smoothed: number;
  calibrated: boolean;
  /** Frames left in calibration, 0 once done. */
  calibrationMsLeft: number;
  /** p95 of the idle samples, the room's own noise. */
  floorP95: number;
  /** Idle threshold = max(MIN_THRESHOLD, floorP95 × idleMultiplier). */
  idleThreshold: number;
  /** p95 of what the mic hears of the synthesiser during the guard window. */
  echoFloor: number;
  /** How many echo samples that rests on. */
  echoSamples: number;
  /** Speaking threshold = max(idleThreshold × SPEAKING_BOOST, echoFloor × echoMultiplier). */
  speakingThreshold: number;
  /** Whichever threshold applies this frame. */
  threshold: number;
  synthSpeaking: boolean;
  inGuard: boolean;
  msSinceChunkStart: number;
  /** Fill of the rolling window: share of frames over threshold. */
  windowRatio: number;
  windowFrames: number;
  /** Window full enough and over the ratio. */
  sustained: boolean;
  /** Last frame at which sustained speech was seen while nothing played. */
  speechDetectedAt: number;
  /** Last frame at which barge-in fired. */
  firedAt: number;
}

export const EMPTY_SNAPSHOT: DetectorSnapshot = {
  at: 0,
  live: false,
  rms: 0,
  smoothed: 0,
  calibrated: false,
  calibrationMsLeft: 0,
  floorP95: 0,
  idleThreshold: 0,
  echoFloor: 0,
  echoSamples: 0,
  speakingThreshold: 0,
  threshold: 0,
  synthSpeaking: false,
  inGuard: false,
  msSinceChunkStart: 0,
  windowRatio: 0,
  windowFrames: 0,
  sustained: false,
  speechDetectedAt: 0,
  firedAt: 0,
};

let snapshot: DetectorSnapshot = EMPTY_SNAPSHOT;

/** Called by the analyser tick, once per frame. Replaces, never merges. */
export function publishSnapshot(next: DetectorSnapshot): void {
  snapshot = next;
}

export function readSnapshot(): DetectorSnapshot {
  return snapshot;
}

/* ---------------------------------------------------------- commands ---- */

let recalibrationRequested = false;

/** Ask the tick to throw away its idle and echo samples and measure again. */
export function requestRecalibration(): void {
  recalibrationRequested = true;
}

/** The tick calls this each frame; true exactly once per request. */
export function takeRecalibrationRequest(): boolean {
  if (!recalibrationRequested) return false;
  recalibrationRequested = false;
  return true;
}
