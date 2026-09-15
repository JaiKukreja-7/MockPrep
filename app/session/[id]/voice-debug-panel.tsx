"use client";

import { useEffect, useState, type CSSProperties } from "react";
import {
  DEFAULT_TUNING,
  getTuning,
  onTuningChange,
  readSnapshot,
  requestRecalibration,
  resetTuning,
  setTuning,
  SPEAKING_BOOST,
  thresholdsFor,
  type DetectorSnapshot,
  type Tuning,
} from "@/lib/voice/barge-in-tuning";
import {
  clearVoiceLog,
  onVoiceLog,
  voiceLogEntries,
  type VoiceLogEntry,
} from "@/lib/voice/voice-log";

/**
 * The barge-in instrument. Mounted only behind ?debug=1 and only outside
 * production (voice-round.tsx does the gating and never imports this file in
 * a production bundle).
 *
 * Deliberately outside the design system: monospace, dark, lime, inline
 * styles. It must never be mistaken for product UI, and it must not depend
 * on tokens that a future design change could move.
 *
 * It shows the detector's own numbers, read straight from the snapshot the
 * analyser tick publishes every frame; the counters and the event list are
 * derived from the same __voiceLog ring buffer that the console reads. It
 * is a faster surface over that data, not a second source of it.
 */

export interface VoiceDebugPanelProps {
  /** Arms the microphone if it is not already (the test utterance needs it). */
  arm: () => Promise<boolean>;
  /** Speaks `text` through the same path a question takes. */
  speakTest: (text: string) => void;
}

/**
 * Roughly forty seconds at rate 1.05, in several chunks, with clause breaks
 * that give a listener natural places to cut in. Spoken through the same
 * speak() path a question takes, so interrupting it exercises exactly the
 * code that a real round would.
 */
const TEST_UTTERANCE =
  "This is a test utterance for tuning the interrupt detector. It runs for " +
  "about forty seconds so you have time to try cutting in at different " +
  "points. Start by saying nothing at all, and watch whether the level " +
  "ever crosses the bar on its own. Then say a word or two, quietly, and " +
  "see if the window fills. Then speak at a normal volume for a full " +
  "second and the interviewer should stop. If it stops while you are " +
  "silent, the echo is clearing the bar and the echo multiplier wants " +
  "raising. If it never stops when you speak, the idle multiplier wants " +
  "lowering. There is no hurry; the utterance repeats its own advice so " +
  "you can try again: silence first, a quiet word next, then a proper " +
  "sentence at the volume you would actually use in an interview.";

/* Events that fire every frame or every word would drown the list. */
const NOISY = new Set(["mic.level", "chunk.boundary"]);
/** How long the big indicator stays lit after the last sustained frame. */
const HOLD_MS = 900;

export function VoiceDebugPanel({ arm, speakTest }: VoiceDebugPanelProps) {
  const [snap, setSnap] = useState<DetectorSnapshot>(readSnapshot);
  const [tuning, setTuningState] = useState<Tuning>(() => ({ ...getTuning() }));
  const [logVersion, setLogVersion] = useState(0);

  // Poll the snapshot on the browser's frame clock. It is a plain object the
  // tick replaces each frame; reading it here costs nothing and keeps React
  // out of the analyser's way.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      setSnap(readSnapshot());
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => onTuningChange(() => setTuningState({ ...getTuning() })), []);
  useEffect(() => onVoiceLog(() => setLogVersion((v) => v + 1)), []);

  const entries = voiceLogEntries();
  const counters = countEvents(entries);
  const recent = entries.filter((e) => !NOISY.has(e.kind)).slice(-5).reverse();

  const now = snap.at;
  const speechLit = snap.live && now - snap.speechDetectedAt < HOLD_MS;
  const firedLit = snap.live && now - snap.firedAt < HOLD_MS;
  const overNow = snap.live && snap.rms > snap.threshold;

  // What the sliders produce, from the same formula the tick uses. Computed
  // here as well so the numbers follow the sliders even before the mic is
  // armed and the tick is publishing.
  const { idle: idleThreshold, speaking: speakingThreshold } = thresholdsFor(
    snap.floorP95,
    snap.echoFloor,
    tuning,
  );

  return (
    <aside style={panel} aria-label="Barge-in debug panel" data-log-version={logVersion}>
      <header style={row}>
        <strong style={{ letterSpacing: "0.08em" }}>BARGE-IN</strong>
        <span style={{ color: snap.live ? LIME : DIM }}>
          {snap.live ? "mic live" : "mic not armed"}
        </span>
      </header>

      {/* ---------------------------------------------------- control case
          The deaf-detector check. Lit = your voice cleared the bar while
          nothing was playing, i.e. it would have barged in. If you talk and
          this never lights, the threshold is above your voice. */}
      <div
        style={{
          ...indicator,
          background: speechLit ? LIME : firedLit ? RED : "#1b1b1b",
          color: speechLit || firedLit ? "#000" : DIM,
          borderColor: speechLit ? LIME : firedLit ? RED : "#333",
        }}
      >
        {firedLit
          ? "BARGE-IN FIRED"
          : speechLit
            ? "SPEECH DETECTED — nothing playing"
            : snap.calibrated
              ? "quiet"
              : "calibrating…"}
      </div>

      {/* --------------------------------------------------------- level */}
      <Section title="level">
        <Bar
          value={snap.rms}
          marker={snap.threshold}
          label={`rms ${fmt(snap.rms)}`}
          right={`bar ${fmt(snap.threshold)}`}
          hot={overNow}
        />
        <Line k="smoothed (meter)" v={fmt(snap.smoothed)} />
      </Section>

      {/* ------------------------------------------------------ thresholds */}
      <Section title="thresholds">
        <Line
          k="calibration"
          v={snap.calibrated ? "done" : `${Math.ceil(snap.calibrationMsLeft)} ms left`}
          hot={!snap.calibrated}
        />
        <Line k="idle floor p95" v={fmt(snap.floorP95)} />
        <Line
          k={`× ${tuning.idleMultiplier.toFixed(2)} → idle threshold`}
          v={fmt(idleThreshold)}
          hot={!snap.synthSpeaking && snap.live}
        />
        <Line
          k={`echo floor p95 (${snap.echoSamples} samples)`}
          v={snap.echoSamples >= 15 ? fmt(snap.echoFloor) : "—"}
        />
        <Line
          k={`max(idle × ${SPEAKING_BOOST}, echo × ${tuning.echoMultiplier.toFixed(2)}) → speaking`}
          v={fmt(speakingThreshold)}
          hot={snap.synthSpeaking}
        />
      </Section>

      {/* ----------------------------------------------------------- state */}
      <Section title="state">
        <Line k="synthSpeaking" v={snap.synthSpeaking ? "yes" : "no"} hot={snap.synthSpeaking} />
        <Line
          k={`guard (first ${tuning.guardMs} ms of chunk)`}
          v={
            snap.synthSpeaking
              ? `${snap.inGuard ? "INSIDE" : "past"} · ${Math.round(snap.msSinceChunkStart)} ms in`
              : "—"
          }
          hot={snap.inGuard}
        />
        <Bar
          value={snap.windowRatio}
          marker={tuning.windowRatio}
          label={`window ${Math.round(snap.windowRatio * 100)}% over`}
          right={`trigger ${Math.round(tuning.windowRatio * 100)}% · ${snap.windowFrames} frames`}
          hot={snap.sustained}
        />
      </Section>

      {/* -------------------------------------------------------- counters */}
      <Section
        title="counters"
        aside={
          <button type="button" style={linkButton} onClick={clearVoiceLog}>
            clear log
          </button>
        }
      >
        <div style={grid4}>
          <Counter n={counters.fires} label="fires" hot={counters.fires > 0} />
          <Counter n={counters.suppressed} label="suppressed" />
          <Counter n={counters.completed} label="chunks done" />
          <Counter n={counters.interrupted} label="chunks cut" hot={counters.interrupted > 0} />
        </div>
      </Section>

      {/* ---------------------------------------------------------- tuning */}
      <Section
        title="tuning (live)"
        aside={
          <button type="button" style={linkButton} onClick={resetTuning}>
            defaults
          </button>
        }
      >
        <Slider
          label="idle ×"
          value={tuning.idleMultiplier}
          min={1}
          max={4}
          step={0.05}
          onChange={(v) => setTuning({ idleMultiplier: v })}
          result={`idle bar ${fmt(idleThreshold)}`}
          isDefault={tuning.idleMultiplier === DEFAULT_TUNING.idleMultiplier}
        />
        <Slider
          label="echo ×"
          value={tuning.echoMultiplier}
          min={1}
          max={4}
          step={0.05}
          onChange={(v) => setTuning({ echoMultiplier: v })}
          result={`speaking bar ${fmt(speakingThreshold)}`}
          isDefault={tuning.echoMultiplier === DEFAULT_TUNING.echoMultiplier}
        />
        <Slider
          label="guard ms"
          value={tuning.guardMs}
          min={0}
          max={2000}
          step={50}
          onChange={(v) => setTuning({ guardMs: v })}
          result={`${tuning.guardMs} ms`}
          isDefault={tuning.guardMs === DEFAULT_TUNING.guardMs}
        />
        <Slider
          label="window %"
          value={tuning.windowRatio}
          min={0.2}
          max={1}
          step={0.05}
          onChange={(v) => setTuning({ windowRatio: v })}
          result={`${Math.round(tuning.windowRatio * 100)}% of 600 ms`}
          isDefault={tuning.windowRatio === DEFAULT_TUNING.windowRatio}
        />
      </Section>

      {/* --------------------------------------------------------- actions */}
      <div style={{ ...row, gap: 8 }}>
        <button
          type="button"
          style={button}
          onClick={async () => {
            if (await arm()) speakTest(TEST_UTTERANCE);
          }}
        >
          ▶ play test utterance
        </button>
        <button
          type="button"
          style={button}
          onClick={async () => {
            await arm();
            requestRecalibration();
          }}
        >
          ↺ reset calibration
        </button>
      </div>

      {/* ---------------------------------------------------------- events */}
      <Section title="last events (newest first)">
        {recent.length === 0 ? (
          <div style={{ color: DIM }}>nothing yet</div>
        ) : (
          recent.map((e, i) => <Event key={`${e.t}-${e.kind}-${i}`} entry={e} />)
        )}
        <div style={{ color: DIM, marginTop: 4 }}>
          full timeline: <code>__voiceLog.dump()</code>
        </div>
      </Section>
    </aside>
  );
}

/* ---------------------------------------------------------------- pieces */

function countEvents(entries: readonly VoiceLogEntry[]) {
  let fires = 0;
  let suppressed = 0;
  let completed = 0;
  let interrupted = 0;
  for (const e of entries) {
    if (e.kind === "bargein.fire") fires += 1;
    else if (e.kind === "bargein.suppressed") suppressed += 1;
    else if (e.kind === "chunk.end") {
      if (e.detail.completed) completed += 1;
      else interrupted += 1;
    } else if (e.kind === "chunk.error") {
      const err = String(e.detail.error ?? "");
      if (err === "interrupted" || err === "canceled") interrupted += 1;
    }
  }
  return { fires, suppressed, completed, interrupted };
}

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginTop: 10 }}>
      <div style={{ ...row, color: DIM, marginBottom: 4 }}>
        <span style={{ letterSpacing: "0.08em", textTransform: "uppercase" }}>{title}</span>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Line({ k, v, hot }: { k: string; v: string; hot?: boolean }) {
  return (
    <div style={{ ...row, color: hot ? LIME : "#ddd" }}>
      <span style={{ color: hot ? LIME : DIM }}>{k}</span>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{v}</span>
    </div>
  );
}

/** A 0..1 bar with a marker at `marker`. Scale is fixed so bars compare across time. */
function Bar({
  value,
  marker,
  label,
  right,
  hot,
}: {
  value: number;
  marker: number;
  label: string;
  right: string;
  hot: boolean;
}) {
  const scale = 0.6; // RMS above 0.6 is shouting; the window ratio is 0..1
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  const isRatio = marker <= 1 && label.startsWith("window");
  const v = isRatio ? clamp(value) : clamp(value / scale);
  const m = isRatio ? clamp(marker) : clamp(marker / scale);
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ ...row, fontVariantNumeric: "tabular-nums" }}>
        <span style={{ color: hot ? LIME : "#ddd" }}>{label}</span>
        <span style={{ color: DIM }}>{right}</span>
      </div>
      <div style={{ position: "relative", height: 10, background: "#1b1b1b", marginTop: 3 }}>
        <div
          style={{
            position: "absolute",
            inset: "0 auto 0 0",
            width: `${v * 100}%`,
            background: hot ? LIME : "#777",
          }}
        />
        <div
          style={{
            position: "absolute",
            top: -2,
            bottom: -2,
            left: `${m * 100}%`,
            width: 2,
            background: RED,
          }}
        />
      </div>
    </div>
  );
}

function Counter({ n, label, hot }: { n: number; label: string; hot?: boolean }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div
        style={{
          fontSize: 22,
          lineHeight: 1,
          fontVariantNumeric: "tabular-nums",
          color: hot ? LIME : "#ddd",
        }}
      >
        {n}
      </div>
      <div style={{ color: DIM, marginTop: 2 }}>{label}</div>
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  result,
  isDefault,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  result: string;
  isDefault: boolean;
}) {
  return (
    <label style={{ display: "block", marginBottom: 6 }}>
      <div style={{ ...row, fontVariantNumeric: "tabular-nums" }}>
        <span style={{ color: isDefault ? DIM : LIME }}>
          {label} {step < 1 ? value.toFixed(2) : value}
          {isDefault ? "" : " *"}
        </span>
        <span style={{ color: "#ddd" }}>{result}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: "100%", accentColor: LIME, margin: "2px 0 0" }}
      />
    </label>
  );
}

function Event({ entry }: { entry: VoiceLogEntry }) {
  const hot =
    entry.kind === "bargein.fire" ||
    entry.kind === "speech.detected" ||
    entry.kind === "chunk.error";
  const detail = Object.entries(entry.detail)
    .filter(([k]) => k !== "by" && k !== "text" && k !== "note")
    .slice(0, 4)
    .map(([k, v]) => `${k}=${typeof v === "number" && !Number.isInteger(v) ? fmt(v) : String(v)}`)
    .join(" ");
  return (
    <div style={{ ...row, alignItems: "baseline", gap: 8 }}>
      <span style={{ color: DIM, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
        {String(entry.t).padStart(6)}ms
      </span>
      <span style={{ color: hot ? LIME : "#ddd", flexShrink: 0 }}>{entry.kind}</span>
      <span
        style={{
          color: DIM,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          textAlign: "right",
        }}
      >
        {detail}
      </span>
    </div>
  );
}

function fmt(n: number) {
  return (Math.round(n * 1000) / 1000).toFixed(3);
}

/* ---------------------------------------------------------------- styles */

const LIME = "#b6ff3b";
const RED = "#ff3b5c";
const DIM = "#8a8a8a";

const panel: CSSProperties = {
  position: "fixed",
  top: 12,
  right: 12,
  zIndex: 9999,
  width: 360,
  maxHeight: "calc(100vh - 24px)",
  overflowY: "auto",
  padding: 12,
  background: "rgba(10, 10, 10, 0.94)",
  color: "#ddd",
  fontFamily: "ui-monospace, Menlo, Consolas, monospace",
  fontSize: 11,
  lineHeight: 1.4,
  border: "1px solid #333",
  borderRadius: 6,
  boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
};

const row: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
};

const indicator: CSSProperties = {
  marginTop: 10,
  padding: "14px 10px",
  textAlign: "center",
  fontSize: 14,
  fontWeight: 700,
  letterSpacing: "0.06em",
  border: "2px solid",
  borderRadius: 4,
  transition: "background 80ms linear",
};

const grid4: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, 1fr)",
  gap: 8,
};

const button: CSSProperties = {
  flex: 1,
  padding: "8px 6px",
  background: "#1b1b1b",
  color: "#ddd",
  border: "1px solid #444",
  borderRadius: 4,
  font: "inherit",
  cursor: "pointer",
};

const linkButton: CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  color: DIM,
  font: "inherit",
  textDecoration: "underline",
  cursor: "pointer",
};
