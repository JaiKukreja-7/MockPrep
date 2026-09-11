"use client";

import { useEffect, useRef, useState } from "react";
import { Speaker, type SpeakerHandle } from "@/components/ui";

/**
 * Four states side by side. The speaking instance is pulsed at 4.5 words a
 * second — the top of a natural pace — so the cap and the throttle are
 * visible doing their work rather than described.
 */
export function SpeakerDemo() {
  const speakingRef = useRef<SpeakerHandle>(null);
  const [level, setLevel] = useState(0.35);

  useEffect(() => {
    const words = setInterval(() => speakingRef.current?.pulse(), 220);
    // A slow swell on the listening form, standing in for a voice.
    let t = 0;
    const swell = setInterval(() => {
      t += 0.12;
      setLevel(0.45 + Math.sin(t) * 0.3);
    }, 80);
    return () => {
      clearInterval(words);
      clearInterval(swell);
    };
  }, []);

  const cells = [
    { label: "Idle", note: "Nothing playing, mic off", state: "idle" as const },
    { label: "Speaking", note: "Pulsed at 4.5 words/s", state: "speaking" as const },
    { label: "Listening", note: "Hollow; fills with mic level", state: "listening" as const },
    { label: "Thinking", note: "Waiting on the API", state: "thinking" as const },
  ];

  return (
    <div className="grid grid-cols-2 gap-x-8 md:grid-cols-4">
      {cells.map((cell) => (
        <div key={cell.state} className="border-t border-t-rule py-6">
          <p className="eyebrow">{cell.label}</p>
          <p className="text-u-micro">{cell.note}</p>
          <Speaker
            ref={cell.state === "speaking" ? speakingRef : undefined}
            state={cell.state}
            level={cell.state === "listening" ? level : 0}
            className="mt-4 h-24 w-40"
          />
        </div>
      ))}
    </div>
  );
}
