import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Button } from "@/components/ui";
import { getSession } from "@/lib/data/session";
import { sweepIfStale } from "@/lib/rounds/sweep";
import { LiveRound } from "./live-round";

export const metadata = { title: "Live session — MockPrep" };

// Vercel: a server action runs under the segment config of the page that
// posts it, so the limit for submitAnswer and scoreRound lives here. Scoring runs answer scoring and flag extraction in parallel, and each may
// spend the backoff ladder before failing over; 30s has been seen.
// The platform default would cut it off.
export const maxDuration = 120;

export default async function SessionPage({ params }: PageProps<"/session/[id]">) {
  const { id } = await params;
  // Before reading: a live round left for an hour is swept here, so it can
  // never resume with a wall-clock elapsed time.
  await sweepIfStale(id);
  const view = await getSession(id);

  if (!view) notFound();
  // A finished round belongs on its report, not back in the interview.
  if (view.session.status === "scored") redirect(`/report/${id}`);

  if (view.session.status === "abandoned") {
    return (
      <div className="flex flex-1 flex-col">
        <header className="flex h-[72px] shrink-0 items-center border-b border-b-rule px-8">
          <span className="display text-u-body">
            MockPrep<sup>®</sup>
          </span>
        </header>
        <main className="flex flex-1 flex-col gap-6 px-8 py-12">
          <p className="eyebrow">This round was left open</p>
          <h1 className="display text-u-display max-w-4xl">
            It timed out after an hour of quiet.
          </h1>
          <p className="text-u-body max-w-2xl">
            Nothing you said was lost — it is in the transcript on your
            sessions list — but the round cannot be picked back up. Start a
            fresh one when you are ready.
          </p>
          <div className="flex flex-wrap gap-4">
            <Link href="/dashboard">
              <Button>Start a new round</Button>
            </Link>
            <Link href="/sessions">
              <Button variant="outline" size="compact">See past rounds</Button>
            </Link>
          </div>
        </main>
      </div>
    );
  }

  return <LiveRound view={view} />;
}
