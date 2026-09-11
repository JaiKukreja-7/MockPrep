"use client";

import {
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
} from "react";

export type SpeakerState = "idle" | "speaking" | "listening" | "thinking";

export interface SpeakerHandle {
  /** One word reached. Emits a ring, subject to the cap and the throttle. */
  pulse(): void;
}

export interface SpeakerProps {
  state: SpeakerState;
  /** 0..1 mic level. Fills the hollow form while listening. */
  level?: number;
  ref?: Ref<SpeakerHandle>;
  className?: string;
}

/*
  The rings are the disciplined part.

  A natural speaking pace is three to five words a second. One ring per word
  at that rate stacks into a continuous pulse — which reads as a glow, and
  glow is on the banned list. So two limits, both measured against that pace:

    MAX_RINGS          how many can be alive at once
    MIN_RING_GAP_MS    the shortest spacing between two emissions

  With a 1.2s ring lifetime, a 320ms gap yields rings ~7.5px apart in radius
  at any instant, and never more than three — concentric marks with clear
  space between them. Words that arrive inside the gap, or while three rings
  are alive, are simply not drawn. The speech is not throttled; only the ink.
*/
const MAX_RINGS = 3;
const MIN_RING_GAP_MS = 320;

const VIEW_W = 160;
const VIEW_H = 96;
const CX = VIEW_W / 2;
const CY = VIEW_H / 2;

const R_SMALL = 4;
const R_LARGE = 12;
const R_ARC = 16;
const ARC_CIRCUMFERENCE = 2 * Math.PI * R_ARC;

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void) {
  const mql = window.matchMedia(reducedMotionQuery);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(reducedMotionQuery).matches,
    () => false,
  );
}

/**
 * The interviewer, seen. An abstract form built from the accent dot that
 * already marks state on the voice screen.
 *
 * Four states, distinguishable without motion:
 *
 *   idle       small solid dot
 *   speaking   large solid dot, breathing; a hairline ring per word
 *   listening  hollow circle, filling from the bottom with mic level
 *   thinking   small solid dot with a 270° hairline arc orbiting it
 *
 * Solid means the interviewer. Hollow means you. That split is the whole
 * point: it is what lets a user tell "the interviewer is speaking" from "you
 * are being recorded" at a glance, and it holds when animation is off.
 */
export function Speaker({ state, level = 0, ref, className }: SpeakerProps) {
  const reducedMotion = useReducedMotion();
  const [rings, setRings] = useState<number[]>([]);
  const lastEmitRef = useRef(0);
  const nextIdRef = useRef(0);

  // Rings belong to one speaking bout. When the state changes, drop them
  // during render rather than in an effect, so there is no extra commit.
  const [seenState, setSeenState] = useState(state);
  if (seenState !== state) {
    setSeenState(state);
    if (state !== "speaking" && rings.length > 0) setRings([]);
  }

  useImperativeHandle(
    ref,
    () => ({
      pulse() {
        if (state !== "speaking" || reducedMotion) return;
        const now = performance.now();
        if (now - lastEmitRef.current < MIN_RING_GAP_MS) return;
        if (rings.length >= MAX_RINGS) return;
        lastEmitRef.current = now;
        const id = nextIdRef.current++;
        setRings((prev) => [...prev, id]);
      },
    }),
    // rings.length is a dependency on purpose: the cap must see the live
    // count, and rebuilding a tiny handle per ring is cheaper than a ref
    // written during render.
    [state, reducedMotion, rings.length],
  );

  const removeRing = (id: number) =>
    setRings((prev) => prev.filter((r) => r !== id));

  const clamped = Math.max(0, Math.min(1, level));
  const fillHeight = R_LARGE * 2 * clamped;

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      className={["block", className].filter(Boolean).join(" ")}
      role="img"
      aria-label={ARIA_LABEL[state]}
    >
      {state === "idle" && (
        <circle cx={CX} cy={CY} r={R_SMALL} fill="var(--accent)" />
      )}

      {state === "speaking" && (
        <>
          {rings.map((id) => (
            <circle
              key={id}
              className="speaker-ring"
              cx={CX}
              cy={CY}
              r={R_LARGE}
              fill="none"
              stroke="var(--accent)"
              strokeWidth={1}
              onAnimationEnd={() => removeRing(id)}
            />
          ))}
          <circle
            className="speaker-breathe"
            style={{ transformOrigin: `${CX}px ${CY}px` }}
            cx={CX}
            cy={CY}
            r={R_LARGE}
            fill="var(--accent)"
          />
        </>
      )}

      {state === "listening" && (
        <>
          <circle
            cx={CX}
            cy={CY}
            r={R_LARGE}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={1}
          />
          <clipPath id="speaker-fill">
            <rect
              x={CX - R_LARGE - 1}
              y={CY + R_LARGE - fillHeight}
              width={R_LARGE * 2 + 2}
              height={fillHeight}
            />
          </clipPath>
          <circle
            cx={CX}
            cy={CY}
            r={R_LARGE}
            fill="var(--accent)"
            clipPath="url(#speaker-fill)"
          />
        </>
      )}

      {state === "thinking" && (
        <>
          <circle cx={CX} cy={CY} r={R_SMALL} fill="var(--accent)" />
          <circle
            className="speaker-orbit"
            style={{ transformOrigin: `${CX}px ${CY}px` }}
            cx={CX}
            cy={CY}
            r={R_ARC}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={1}
            strokeDasharray={`${ARC_CIRCUMFERENCE * 0.75} ${ARC_CIRCUMFERENCE * 0.25}`}
          />
        </>
      )}
    </svg>
  );
}

const ARIA_LABEL: Record<SpeakerState, string> = {
  idle: "Interviewer idle",
  speaking: "Interviewer speaking",
  listening: "Recording you",
  thinking: "Interviewer thinking",
};
