"use client";

/**
 * Diagnostic ring buffer for the voice path.
 *
 * Every speech-synthesis event, every cancel (with the stack that caused it),
 * every barge-in trigger with its RMS, and the mic level while the
 * synthesiser is talking — all on one timeline, so a truncated question can
 * be traced to whatever actually stopped it rather than guessed at.
 *
 * Read it in the browser console:
 *   __voiceLog.dump()    the whole timeline as text
 *   __voiceLog.copy()    the same, onto the clipboard
 *   __voiceLog.clear()   reset before a fresh attempt
 */

export interface VoiceLogEntry {
  /** Milliseconds since the first entry. */
  t: number;
  kind: string;
  detail: Record<string, unknown>;
}

const MAX_ENTRIES = 1000;
const entries: VoiceLogEntry[] = [];
let origin = 0;
let installed = false;
const listeners = new Set<() => void>();

/** Notified after every entry, and on clear. The debug panel hangs off this. */
export function onVoiceLog(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Read access for the panel — the same array __voiceLog.entries points at. */
export function voiceLogEntries(): readonly VoiceLogEntry[] {
  return entries;
}

export function clearVoiceLog(): void {
  entries.length = 0;
  origin = 0;
  for (const fn of listeners) fn();
}

/** Live console output is dev-only; the buffer always collects. */
const LIVE = process.env.NODE_ENV !== "production";

export function vlog(kind: string, detail: Record<string, unknown> = {}) {
  if (typeof window === "undefined") return;

  if (origin === 0) origin = performance.now();
  const t = Math.round(performance.now() - origin);

  entries.push({ t, kind, detail });
  if (entries.length > MAX_ENTRIES) entries.shift();
  for (const fn of listeners) fn();

  if (LIVE) {
    const stamp = String(t).padStart(6, " ");
    console.log(`%c[voice ${stamp}ms] ${kind}`, "color:#FF3454", detail);
  }

  install();
}

/**
 * The immediate callers of whatever we are logging, with this module's own
 * frames stripped. This is what identifies which code path cancelled speech.
 */
export function callerStack(depth = 6): string {
  const raw = new Error().stack ?? "";
  return raw
    .split("\n")
    .slice(1)
    .filter((line) => !line.includes("voice-log"))
    .slice(0, depth)
    .map((line) => line.trim().replace(/^at\s+/, ""))
    .join(" <- ");
}

function dump(): string {
  if (entries.length === 0) return "(voice log empty)";
  const lines = entries.map((e) => {
    const detail = Object.entries(e.detail)
      .map(([k, v]) => `${k}=${format(v)}`)
      .join(" ");
    return `${String(e.t).padStart(7)}ms  ${e.kind.padEnd(26)} ${detail}`;
  });
  return [
    "=== MockPrep voice log ===",
    `entries: ${entries.length}`,
    "",
    ...lines,
  ].join("\n");
}

function format(value: unknown): string {
  if (typeof value === "string") {
    return value.length > 90 ? JSON.stringify(`${value.slice(0, 90)}…`) : JSON.stringify(value);
  }
  if (typeof value === "number") return String(Math.round(value * 1000) / 1000);
  return JSON.stringify(value);
}

let synthesisPatched = false;

/**
 * Wraps speechSynthesis.cancel/pause/resume so that ANY caller is recorded,
 * not just our own stopSpeaking().
 *
 * This is the difference between "we cancelled it" and "something cancelled
 * it": an extension, a React internal, or Chrome's own audio policy calling
 * cancel() would otherwise be invisible and look exactly like the bug.
 */
export function instrumentSynthesis() {
  if (synthesisPatched || typeof window === "undefined") return;
  if (!window.speechSynthesis) return;
  synthesisPatched = true;

  const synth = window.speechSynthesis;
  for (const method of ["cancel", "pause", "resume"] as const) {
    const original = synth[method].bind(synth);
    synth[method] = () => {
      vlog(`synth.${method}`, {
        wasSpeaking: synth.speaking,
        pending: synth.pending,
        by: callerStack(),
      });
      return original();
    };
  }
}

function install() {
  if (installed) return;
  installed = true;
  Object.assign(window, {
    __voiceLog: {
      entries,
      dump: () => {
        const text = dump();
        console.log(text);
        return text;
      },
      copy: async () => {
        const text = dump();
        try {
          await navigator.clipboard.writeText(text);
          console.log("%cvoice log copied to clipboard", "color:#FF3454");
        } catch {
          console.log("clipboard blocked — select the dump() output instead");
        }
        return text;
      },
      clear: () => {
        clearVoiceLog();
        console.log("%cvoice log cleared", "color:#FF3454");
      },
    },
  });
}

// Installed on import, not on first event, so __voiceLog is already there
// when the console is opened before a question is spoken.
if (typeof window !== "undefined") install();
