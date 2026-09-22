"use client";

import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { Button } from "@/components/ui";

/**
 * Where an unhandled error lands, instead of Next's "This page couldn't
 * load" with a bare Reload. Same idiom as the dashboard's empty states —
 * eyebrow, one display line, one paragraph, one action — and the action is
 * a way back into what the person was doing: `reset()` re-renders the route
 * they are on, which for a live round is the round.
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const pathname = usePathname();
  const inRound = pathname?.startsWith("/session/");

  useEffect(() => {
    // The digest is what the server log is keyed on.
    console.error("[mockprep] route error", error.digest ?? "", error);
  }, [error]);

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex h-[72px] shrink-0 items-center border-b border-b-rule px-8">
        <span className="display text-u-body">
          MockPrep<sup>®</sup>
        </span>
      </header>
      <main className="flex flex-1 flex-col gap-6 px-8 py-12">
        <p className="eyebrow">Something went wrong</p>
        <h1 className="display text-u-display max-w-4xl">
          That did not go through.
        </h1>
        <p className="text-u-body max-w-2xl">
          {inRound
            ? "The round is still there and everything you had already submitted is saved. Go back in and carry on."
            : "Nothing you had already saved is lost. Try the page again, or go back to the dashboard."}
        </p>
        <div className="flex flex-wrap gap-4">
          <Button onClick={reset}>{inRound ? "Back into the round" : "Try again"}</Button>
          <Button href="/dashboard" variant="outline" size="compact">Back to the dashboard</Button>
        </div>
        {error.digest ? (
          <p className="text-u-micro">
            Reference <span className="numeric">{error.digest}</span>
          </p>
        ) : null}
      </main>
    </div>
  );
}
