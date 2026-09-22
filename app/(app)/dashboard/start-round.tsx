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

      {/* Optional. Either input alone tailors the round; both together add a
          gap question. The level select above is the experience level for a
          tailored round too — one setting, not two. */}
      <fieldset className="mt-10 border-t border-t-rule pt-8" disabled={pending}>
        <legend className="eyebrow float-left mb-6 w-full">Tailor this round · optional</legend>

        <div className="flex flex-wrap items-end gap-6">
          <label className="flex min-w-64 flex-1 flex-col gap-2">
            <span className="eyebrow">
              {isGuest ? "Resume — needs an account" : "Resume — PDF or DOCX"}
            </span>
            {/* Questions probe the projects, stack and claims on it. Read in
                memory and discarded; only the questions are stored. RLS
                rejects a guest's resume-tailored session regardless. */}
            <input
              type="file"
              name="resume"
              accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              disabled={isGuest}
              className="input h-auto rounded-surface py-4 text-u-body file:mr-4 file:rounded-pill file:border-0 file:bg-ink file:px-4 file:py-2 file:text-ink-inverse file:text-u-eyebrow"
            />
          </label>

          <div className="min-w-48 flex-1">
            <Input label="Job title" name="jobTitle" placeholder="Backend engineer" />
          </div>
          <div className="min-w-48 flex-1">
            <Input label="Company" name="company" placeholder="Acme" />
          </div>
        </div>

        <label className="mt-6 flex flex-col gap-2">
          <span className="eyebrow">Job description</span>
          {/* Questions target the stated requirements. Stored on the round. */}
          <textarea
            name="jobDescription"
            rows={6}
            maxLength={8000}
            placeholder="Paste the posting"
            className="input h-auto rounded-surface py-4 leading-normal"
          />
        </label>

        <p className="mt-4 text-u-micro">
          The resume is read in memory and discarded — only the questions it
          produces are stored. The job details stay on the round.
        </p>
      </fieldset>

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
