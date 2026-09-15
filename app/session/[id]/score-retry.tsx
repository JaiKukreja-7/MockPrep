"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Button } from "@/components/ui";
import { scoreRound, type ActionState } from "@/app/rounds/actions";
import { describeSubmitFailure } from "@/lib/client-errors";

/**
 * A round whose every question is answered but whose scoring never went
 * through. Shown in place of the answer form on the session screen, and in
 * place of the score on an unscored report. The answers are already saved;
 * the only thing left to do is the one button.
 */
export function ScoreRetry({ sessionId, why }: { sessionId: string; why?: string }) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    async (prev, formData) => {
      try {
        return await scoreRound(prev, formData);
      } catch (error) {
        return { error: describeSubmitFailure(error, "round").message };
      }
    },
    {},
  );

  return (
    <form action={formAction} className="flex max-w-2xl flex-col gap-6">
      <input type="hidden" name="sessionId" value={sessionId} />
      <p className="text-u-body">
        {why ??
          "The scorer could not be reached when the last answer went in. Everything you said is saved; only the score is missing."}
      </p>

      {pending ? (
        <p className="flex items-center gap-4 text-u-lg" aria-live="polite">
          <span aria-hidden className="size-2 animate-pulse rounded-pill bg-accent" />
          Scoring the round…
        </p>
      ) : null}

      {state.error && !pending ? (
        <p className="text-u-eyebrow text-error" role="alert">
          {state.error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={pending}>
          {pending ? "Scoring…" : "Score this round"}
        </Button>
        <Link href="/sessions" className="eyebrow">
          See past rounds
        </Link>
      </div>
    </form>
  );
}
