"use client";

import { useActionState } from "react";
import { Button, Input } from "@/components/ui";
import { startRound, type ActionState } from "@/app/rounds/actions";
import type { UpNext } from "@/lib/data/dashboard";

const TRACKS = ["consulting", "engineering", "product", "general"] as const;

/**
 * The single entry point into a round. Question generation takes a real
 * round trip — and can spend the backoff ladder before failing over — so the
 * pending state has to say so rather than leaving a dead button.
 */
export function StartRound({
  upNext,
  isGuest,
}: {
  upNext: UpNext | null;
  isGuest: boolean;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    startRound,
    {},
  );

  return (
    <form action={formAction}>
      {upNext ? (
        <p className="text-u-lg mb-6">
          {upNext.title}
          {upNext.when ? (
            <>
              {" "}
              <span aria-hidden>·</span> {upNext.when}
            </>
          ) : null}
        </p>
      ) : null}

      <div className="flex flex-wrap items-end gap-6">
        <div className="min-w-64 flex-1">
          <Input
            label="Role you are interviewing for"
            name="role"
            defaultValue={upNext?.title ?? ""}
            placeholder="Strategy analyst"
            disabled={pending}
          />
        </div>

        <label className="flex min-w-48 flex-col gap-2">
          <span className="eyebrow">Track</span>
          <select name="track" disabled={pending} className="input">
            {TRACKS.map((track) => (
              <option key={track} value={track}>
                {track[0].toUpperCase() + track.slice(1)}
              </option>
            ))}
          </select>
        </label>

        <label className="flex min-w-40 flex-col gap-2">
          <span className="eyebrow">Experience</span>
          {/* Questions are pitched at this. "junior" is the 1–3 years band. */}
          <select name="level" defaultValue="fresher" disabled={pending} className="input">
            <option value="intern">Intern</option>
            <option value="fresher">Fresher</option>
            <option value="junior">1–3 years</option>
          </select>
        </label>

        <label className="flex min-w-40 flex-col gap-2">
          <span className="eyebrow">Mode</span>
          <select name="mode" disabled={pending} className="input">
            <option value="text">Text</option>
            {/* Voice needs a real account — the restrictive RLS policy on
                rounds rejects a guest's voice insert regardless, so this is
                a signpost rather than the enforcement. */}
            <option value="voice" disabled={isGuest}>
              {isGuest ? "Voice (needs an account)" : "Voice"}
            </option>
          </select>
        </label>

        <Button type="submit" disabled={pending}>
          {pending ? "Writing your questions…" : "Start a round"}
        </Button>
      </div>

      {pending ? (
        <p className="mt-4 flex items-center gap-3 text-u-body" aria-live="polite">
          <span aria-hidden className="size-2 animate-pulse rounded-pill bg-accent" />
          The interviewer is thinking…
        </p>
      ) : null}

      {state.error ? (
        <p className="text-u-eyebrow text-error mt-4" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
