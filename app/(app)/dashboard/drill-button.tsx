"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui";
import { startRound, type ActionState } from "@/app/rounds/actions";
import type { DrillDefaults } from "@/lib/data/dashboard";
import type { TranscriptFlag } from "@/lib/supabase/types";

/**
 * Starts a round that presses on one delivery habit.
 *
 * The round is otherwise the shape of their last one — same role, track and
 * level — because a drill is meant to feel like the round they just did,
 * with the questions angled at the habit. The flag is validated against the
 * enum server-side, so the hidden field cannot inject prompt text.
 */
export function DrillButton({
  flag,
  label,
  defaults,
}: {
  flag: TranscriptFlag;
  label: string;
  defaults: DrillDefaults;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(startRound, {});

  return (
    <form action={formAction} className="flex flex-col items-end gap-2">
      <input type="hidden" name="focus" value={flag} />
      <input type="hidden" name="role" value={defaults.role} />
      <input type="hidden" name="track" value={defaults.track} />
      <input type="hidden" name="level" value={defaults.level} />
      <input type="hidden" name="mode" value="text" />
      <Button type="submit" variant="outline" size="compact" disabled={pending}>
        {pending ? "Writing your questions…" : "Drill it"}
      </Button>
      <span className="sr-only">{label}</span>
      {state.error ? (
        <p className="text-u-eyebrow text-error" role="alert">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
