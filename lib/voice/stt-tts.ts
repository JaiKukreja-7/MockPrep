"use client";

import { callerStack, instrumentSynthesis, vlog } from "./voice-log";
import type {
  VoiceSessionHandle,
  VoiceTransport,
  VoiceTurnContext,
  VoiceTurnResult,
} from "./transport";

/**
 * The turn-based transport: record locally, POST to our own server, speak the
 * reply with the browser's own synthesiser.
 *
 * No provider key is involved on this path at all — the browser's only
 * counterparty is /api/voice/turn — which is why it needs no ephemeral token
 * and works today. See transport.ts for what the duplex relay would replace.
 */
export function createSttTtsTransport(): VoiceTransport {
  return {
    id: "stt-tts",
    label: "Whisper + Flash + Web Speech",

    isAvailable() {
      return (
        typeof window !== "undefined" &&
        typeof window.MediaRecorder !== "undefined" &&
        Boolean(navigator.mediaDevices?.getUserMedia)
      );
    },

    async connect(sessionId: string): Promise<VoiceSessionHandle> {
      return {
        async sendUtterance(audio: Blob, turn: VoiceTurnContext) {
          const form = new FormData();
          form.append("sessionId", sessionId);
          form.append("roundId", turn.roundId);
          form.append("offsetMs", String(turn.offsetMs));
          // The extension has to match the bytes: Whisper keys its decoder off
          // the filename, and iOS hands over MP4, not WebM.
          form.append("audio", audio, `utterance.${extensionFor(audio.type)}`);

          const response = await fetch("/api/voice/turn", {
            method: "POST",
            body: form,
          });

          // A non-JSON body means the request never reached the route — the
          // proxy answered, or a captive portal did. Say so rather than
          // throwing a JSON parse error at the person.
          const body = (await response.json().catch(() => null)) as
            | (VoiceTurnResult & { error?: string })
            | null;
          if (!body) {
            throw new Error(
              response.status === 401 || response.status === 403
                ? "Not signed in."
                : `The server did not answer properly (${response.status}).`,
            );
          }
          if (!response.ok || (body.error && !body.scoringFailed)) {
            throw new Error(body.error ?? `Turn failed (${response.status})`);
          }
          return body;
        },

        interrupt() {
          stopSpeaking();
        },

        close() {
          stopSpeaking();
        },
      };
    },
  };
}

function extensionFor(mimeType: string): string {
  if (mimeType.includes("mp4") || mimeType.includes("aac")) return "mp4";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("wav")) return "wav";
  return "webm";
}

/* ==========================================================================
   TEXT TO SPEECH
   --------------------------------------------------------------------------
   Three things make Web Speech misbehave in Chrome, and this module exists to
   defuse all three:

   1. getVoices() is empty on first call. Chrome populates the list
      asynchronously and fires `voiceschanged`. An utterance queued before
      that can be dropped without any error, so every speak() waits for the
      list first.

   2. Autoplay policy. speechSynthesis.speak() is ignored until the document
      has had a user gesture, and it fails SILENTLY — no exception, no
      onerror, `speaking` just stays false. primeSpeech() burns a muted
      utterance inside a real gesture handler to unlock the document, and
      speak() resolves with an explicit outcome so the UI can tell a silent
      refusal apart from a deliberate interruption.

   3. Chrome stops synthesising part-way through a long utterance, at roughly
      fifteen seconds. Pulsing resume() does not reliably hold it. Instead,
      text is split at sentence boundaries into segments short enough never to
      reach the cutoff, and each segment's onend starts the next. Short
      utterances simply do not hit the bug, so it stops existing rather than
      being papered over.
   ========================================================================== */

/** Comfortably under the cutoff at normal speaking rate. */
const MAX_CHUNK_CHARS = 180;

/**
 * Splits text into speakable segments.
 *
 * Sentences first, because a break mid-sentence is audible. Sentences are
 * then packed greedily so short ones travel together, and any single sentence
 * longer than the limit is broken at a clause boundary, then a word boundary,
 * and only as a last resort mid-word.
 */
export function chunkForSpeech(
  text: string,
  max: number = MAX_CHUNK_CHARS,
): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= max) return [trimmed];

  const sentences = trimmed.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [
    trimmed,
  ];

  const chunks: string[] = [];
  let buffer = "";

  for (const raw of sentences) {
    const sentence = raw.trim();
    if (!sentence) continue;

    if (sentence.length > max) {
      if (buffer) {
        chunks.push(buffer);
        buffer = "";
      }
      chunks.push(...splitLongSentence(sentence, max));
      continue;
    }

    const candidate = buffer ? `${buffer} ${sentence}` : sentence;
    if (candidate.length <= max) {
      buffer = candidate;
    } else {
      if (buffer) chunks.push(buffer);
      buffer = sentence;
    }
  }

  if (buffer) chunks.push(buffer);
  return chunks;
}

function splitLongSentence(sentence: string, max: number): string[] {
  const parts: string[] = [];
  let rest = sentence;

  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(
      window.lastIndexOf(", "),
      window.lastIndexOf("; "),
      window.lastIndexOf(": "),
      window.lastIndexOf(" — "),
    );
    // Include the punctuation itself in the spoken segment.
    if (cut > 0) cut += 1;
    if (cut <= 0) cut = window.lastIndexOf(" ");
    // A single unbroken token longer than the limit: cut it rather than
    // emit something that will be truncated by the browser instead.
    if (cut <= 0) cut = max;

    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest) parts.push(rest);
  return parts;
}

/* -------------------------------------------------------------- voices --- */

let voicesPromise: Promise<SpeechSynthesisVoice[]> | null = null;

function whenVoicesReady(): Promise<SpeechSynthesisVoice[]> {
  if (voicesPromise) return voicesPromise;

  voicesPromise = new Promise((resolve) => {
    const synth = window.speechSynthesis;
    const existing = synth.getVoices();
    if (existing.length > 0) {
      resolve(existing);
      return;
    }

    const onChanged = () => {
      const voices = synth.getVoices();
      if (voices.length > 0) {
        synth.removeEventListener("voiceschanged", onChanged);
        resolve(voices);
      }
    };
    synth.addEventListener("voiceschanged", onChanged);

    // Some builds never fire voiceschanged. Give up waiting rather than
    // leaving the round mute forever.
    setTimeout(() => {
      synth.removeEventListener("voiceschanged", onChanged);
      resolve(synth.getVoices());
    }, 2000);
  });

  return voicesPromise;
}

function pickVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  return (
    voices.find((v) => v.lang.startsWith("en") && v.localService) ??
    voices.find((v) => v.lang.startsWith("en")) ??
    voices[0] ??
    null
  );
}

/* --------------------------------------------------------------- queue --- */

/**
 * Why this is three states and not a boolean: "did not start" conflates a
 * browser that silently refused with an utterance the candidate deliberately
 * talked over. Treating the second as the first pops a "tap to hear" prompt
 * every time barge-in fires, which is precisely backwards.
 */
export type SpeakOutcome = "spoke" | "blocked" | "cancelled";

interface QueuedSpeech {
  chunks: string[];
  onStart?: () => void;
  onEnd?: () => void;
  onBoundary?: () => void;
  settle: (outcome: SpeakOutcome) => void;
  started: boolean;
  finished: boolean;
}

let queue: QueuedSpeech[] = [];
let active: QueuedSpeech | null = null;
let chunkIndex = 0;

/**
 * Bumped by every cancel. Chunk callbacks compare against it and bail out if
 * they are stale, which is what stops a cancelled utterance from scheduling
 * its next chunk — otherwise barge-in would pause and then resume with the
 * remainder of the queue.
 */
let generation = 0;

function finishActive(outcome: SpeakOutcome) {
  if (!active || active.finished) return;
  active.finished = true;
  active.onEnd?.();
  active.settle(outcome);
  active = null;
  chunkIndex = 0;
}

function pump() {
  if (typeof window === "undefined" || !window.speechSynthesis) return;

  if (!active) {
    active = queue.shift() ?? null;
    chunkIndex = 0;
    if (!active) return;
  }

  if (chunkIndex >= active.chunks.length) {
    finishActive(active.started ? "spoke" : "blocked");
    pump();
    return;
  }

  const synth = window.speechSynthesis;
  const current = active;
  const myGeneration = generation;
  const isFirstChunk = chunkIndex === 0;

  const chunkText = current.chunks[chunkIndex];
  const myIndex = chunkIndex;
  const utterance = new SpeechSynthesisUtterance(chunkText);
  const voice = pickVoice(cachedVoices);
  if (voice) utterance.voice = voice;
  utterance.rate = 1.05;

  // Tracks how far through the chunk the synthesiser actually got, which is
  // what distinguishes "finished" from "cut off".
  let queuedAt = performance.now();
  let lastBoundaryChar = 0;
  let startedAt = 0;

  vlog("chunk.queue", {
    i: myIndex,
    of: current.chunks.length,
    chars: chunkText.length,
    gen: myGeneration,
    text: chunkText,
  });

  utterance.onstart = () => {
    startedAt = performance.now();
    lastChunkStartedAt = startedAt;
    vlog("chunk.start", {
      i: myIndex,
      gen: myGeneration,
      stale: myGeneration !== generation,
      waitMs: Math.round(startedAt - queuedAt),
    });
    if (myGeneration !== generation) return;
    if (!current.started) {
      current.started = true;
      current.onStart?.();
    }
  };

  utterance.onboundary = (event) => {
    lastBoundaryChar = event.charIndex;
    if (myGeneration === generation) current.onBoundary?.();
    vlog("chunk.boundary", {
      i: myIndex,
      charIndex: event.charIndex,
      ofChars: chunkText.length,
      name: event.name,
      msIn: startedAt ? Math.round(performance.now() - startedAt) : 0,
    });
  };

  utterance.onend = () => {
    const spokenMs = startedAt ? Math.round(performance.now() - startedAt) : 0;
    // Reaching the final word should leave lastBoundaryChar near the end. A
    // low value here means the utterance was stopped, not completed.
    vlog("chunk.end", {
      i: myIndex,
      gen: myGeneration,
      stale: myGeneration !== generation,
      spokenMs,
      reachedChar: lastBoundaryChar,
      ofChars: chunkText.length,
      completed: lastBoundaryChar >= chunkText.length - 12,
      synthSpeaking: synth.speaking,
    });
    // Stale means cancelled. Do NOT advance the queue.
    if (myGeneration !== generation) return;
    chunkIndex += 1;
    pump();
  };

  utterance.onerror = (event) => {
    vlog("chunk.error", {
      i: myIndex,
      gen: myGeneration,
      stale: myGeneration !== generation,
      error: (event as SpeechSynthesisErrorEvent).error,
      reachedChar: lastBoundaryChar,
      ofChars: chunkText.length,
    });
    if (myGeneration !== generation) return;
    finishActive(current.started ? "cancelled" : "blocked");
    pump();
  };

  queuedAt = performance.now();
  synth.speak(utterance);

  if (isFirstChunk) {
    // Autoplay refusal is silent: no error, no onstart, speaking stays false.
    // If nothing has begun shortly after queueing, give up on this utterance
    // so the UI can surface a "tap to hear" affordance.
    setTimeout(() => {
      if (myGeneration !== generation) return;
      if (!current.started && !synth.speaking) {
        finishActive("blocked");
        pump();
      }
    }, 900);
  }
}

let cachedVoices: SpeechSynthesisVoice[] = [];

/* --------------------------------------------------------------- api ----- */

export interface SpeakOptions {
  /** Cancel whatever is playing first. False queues behind it. */
  interrupt?: boolean;
  onStart?: () => void;
  onEnd?: () => void;
  /** Fires once per word as the synthesiser reaches it. Drives the speaker's rings. */
  onBoundary?: () => void;
}

/**
 * Speaks `text`, split into chunks under the cutoff.
 *
 * Resolves "spoke" on success, "blocked" when the browser silently refused
 * (the caller's cue to ask for a gesture), or "cancelled" when something
 * stopped it — barge-in, a new utterance, or teardown.
 */
export function speak(
  text: string,
  options: SpeakOptions = {},
): Promise<SpeakOutcome> {
  if (typeof window === "undefined" || !window.speechSynthesis || !text.trim()) {
    // Deferred, not called inline: a caller invoking speak() from an effect
    // would otherwise get a setState during render on this path only.
    return Promise.resolve().then((): SpeakOutcome => {
      options.onEnd?.();
      return "blocked";
    });
  }

  installUnloadGuard();
  const chunkPlan = chunkForSpeech(text);
  vlog("speak.call", {
    chars: text.length,
    chunks: chunkPlan.length,
    interrupt: options.interrupt !== false,
    preview: text,
  });

  return whenVoicesReady().then((voices) => {
    cachedVoices = voices;

    if (options.interrupt !== false) stopSpeaking();

    return new Promise<SpeakOutcome>((resolve) => {
      queue.push({
        chunks: chunkForSpeech(text),
        onStart: options.onStart,
        onEnd: options.onEnd,
        onBoundary: options.onBoundary,
        settle: resolve,
        started: false,
        finished: false,
      });
      pump();
    });
  });
}

/**
 * Cancels everything: the chunk being spoken AND the rest of its chunks AND
 * anything queued behind it. Barge-in depends on all three.
 */
export function stopSpeaking(): void {
  if (typeof window === "undefined" || !window.speechSynthesis) return;

  // The stack is the point: it names whichever code path silenced the
  // interviewer — barge-in, an unmount, a new utterance, or teardown.
  vlog("cancel", {
    activeChunk: active ? chunkIndex : null,
    activeChunks: active ? active.chunks.length : 0,
    queued: queue.length,
    wasSpeaking: window.speechSynthesis.speaking,
    gen: generation,
    by: callerStack(),
  });

  generation += 1;

  const pending = active ? [active, ...queue] : [...queue];
  queue = [];
  active = null;
  chunkIndex = 0;

  // Settle every waiting promise so no caller hangs on a cancelled utterance.
  // "cancelled", never "blocked": this path is always a deliberate stop.
  for (const item of pending) {
    if (item.finished) continue;
    item.finished = true;
    item.onEnd?.();
    item.settle("cancelled");
  }

  window.speechSynthesis.cancel();
}

/**
 * When the current chunk began speaking.
 *
 * Barge-in uses this for a guard window: the moment a chunk starts is exactly
 * when the mic is hit hardest by the synthesiser's own onset, and firing there
 * kills the chunk in its first syllable.
 */
let lastChunkStartedAt = 0;

/** Milliseconds since the current chunk started, or Infinity if none has. */
export function msSinceSpeechStart(): number {
  return lastChunkStartedAt === 0
    ? Number.POSITIVE_INFINITY
    : performance.now() - lastChunkStartedAt;
}

export function isSpeaking(): boolean {
  return (
    typeof window !== "undefined" && Boolean(window.speechSynthesis?.speaking)
  );
}

/**
 * Unlocks speech for this document. MUST be called synchronously inside a
 * real user gesture handler — a click, not a promise callback after one.
 */
export function primeSpeech(): void {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  installUnloadGuard();
  const warmup = new SpeechSynthesisUtterance(" ");
  warmup.volume = 0;
  window.speechSynthesis.speak(warmup);
  window.speechSynthesis.resume();
  void whenVoicesReady();
}

/* -------------------------------------------------------------- unload --- */

let unloadGuardInstalled = false;

/**
 * The synthesiser is owned by the browser, not the page: a queue left running
 * can outlive the document and talk over whatever comes next. Cancel on the
 * way out.
 */
function installUnloadGuard() {
  if (unloadGuardInstalled || typeof window === "undefined") return;
  unloadGuardInstalled = true;
  instrumentSynthesis();
  window.addEventListener("pagehide", stopSpeaking);
}
