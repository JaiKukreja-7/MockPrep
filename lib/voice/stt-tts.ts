"use client";

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
          form.append("audio", audio, "utterance.webm");

          const response = await fetch("/api/voice/turn", {
            method: "POST",
            body: form,
          });

          const body = (await response.json()) as VoiceTurnResult & {
            error?: string;
          };
          if (!response.ok || body.error) {
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

/* ==========================================================================
   TEXT TO SPEECH
   --------------------------------------------------------------------------
   Two things make Web Speech silently do nothing in Chrome, and this module
   exists to defuse both:

   1. getVoices() is empty on first call. Chrome populates the list
      asynchronously and fires `voiceschanged`. An utterance queued before
      that can be dropped without any error, so every speak() waits for the
      list first.

   2. Autoplay policy. speechSynthesis.speak() is ignored until the document
      has had a user gesture, and it fails SILENTLY — no exception, no
      onerror, `speaking` just stays false. primeSpeech() burns a muted
      utterance inside a real gesture handler to unlock the document, and
      speak() reports whether audio actually started so the UI can ask for a
      gesture when it did not.
   ========================================================================== */

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

let primed = false;

/**
 * Unlocks speech for this document. MUST be called synchronously inside a
 * real user gesture handler — a click, not a promise callback after one.
 */
export function primeSpeech(): void {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  const warmup = new SpeechSynthesisUtterance(" ");
  warmup.volume = 0;
  window.speechSynthesis.speak(warmup);
  window.speechSynthesis.resume();
  primed = true;
  void whenVoicesReady();
}

export function isSpeechPrimed(): boolean {
  return primed;
}

export interface SpeakOptions {
  /** Cancel whatever is playing first. False queues behind it. */
  interrupt?: boolean;
  onStart?: () => void;
  onEnd?: () => void;
}

/**
 * Speaks `text`. Resolves true if audio actually started, false if the
 * browser silently refused — which is the caller's cue to ask for a gesture.
 */
export function speak(text: string, options: SpeakOptions = {}): Promise<boolean> {
  if (typeof window === "undefined" || !window.speechSynthesis || !text.trim()) {
    // Deferred, not called inline: a caller invoking speak() from an effect
    // would otherwise get a setState during render on this path only, which
    // is exactly the kind of inconsistency that is hard to find later.
    return Promise.resolve().then(() => {
      options.onEnd?.();
      return false;
    });
  }

  const synth = window.speechSynthesis;

  return whenVoicesReady().then(
    (voices) =>
      new Promise<boolean>((resolve) => {
        if (options.interrupt !== false) synth.cancel();

        const utterance = new SpeechSynthesisUtterance(text);
        const voice = pickVoice(voices);
        if (voice) utterance.voice = voice;
        utterance.rate = 1.05;

        let started = false;
        let settled = false;
        const settle = (value: boolean) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };

        utterance.onstart = () => {
          started = true;
          primed = true;
          startKeepAlive();
          options.onStart?.();
          settle(true);
        };
        utterance.onend = () => {
          stopKeepAlive();
          options.onEnd?.();
          settle(started);
        };
        utterance.onerror = () => {
          stopKeepAlive();
          options.onEnd?.();
          settle(false);
        };

        synth.speak(utterance);

        // Autoplay refusal is silent: no error, no onstart, speaking stays
        // false. If nothing has begun shortly after queueing, report failure
        // so the UI can surface a "tap to hear" affordance.
        setTimeout(() => {
          if (!started && !synth.speaking) {
            options.onEnd?.();
            settle(false);
          }
        }, 900);
      }),
  );
}

export function stopSpeaking(): void {
  if (typeof window !== "undefined" && window.speechSynthesis) {
    stopKeepAlive();
    window.speechSynthesis.cancel();
  }
}

export function isSpeaking(): boolean {
  return (
    typeof window !== "undefined" && Boolean(window.speechSynthesis?.speaking)
  );
}

/* Chrome stops synthesising after roughly 15 seconds unless nudged. An
   acknowledgement plus a long question can cross that, so resume() is pulsed
   while speech is in flight. */
let keepAlive: ReturnType<typeof setInterval> | null = null;

function startKeepAlive() {
  if (keepAlive !== null) return;
  keepAlive = setInterval(() => {
    if (window.speechSynthesis.speaking) window.speechSynthesis.resume();
    else stopKeepAlive();
  }, 10_000);
}

function stopKeepAlive() {
  if (keepAlive !== null) {
    clearInterval(keepAlive);
    keepAlive = null;
  }
}
