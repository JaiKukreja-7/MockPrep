import { notFound } from "next/navigation";
import Link from "next/link";
import { Button, PillTag, RuledRow, RuledRowList } from "@/components/ui";
import { getReport } from "@/lib/data/session";
import { ScoreRetry } from "@/app/session/[id]/score-retry";

export const metadata = { title: "Scored report — MockPrep" };

// Vercel: a server action runs under the segment config of the page that
// posts it, so the limit for scoreRound lives here. The unscored report's "Score this round" runs the same scoring as the
// session page.
// The platform default would cut it off.
export const maxDuration = 120;

const FLAG_LABELS: Record<string, string> = {
  filler: "Filler",
  restated: "Restated",
  no_number: "No number",
  rambled: "Rambled",
};

const breakdownRows = [
  { label: "Structure", key: "structure" },
  { label: "Specificity", key: "specificity" },
  { label: "Pace", key: "pace" },
] as const;

function clock(seconds: number | null) {
  if (seconds === null) return null;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default async function ReportPage({ params }: PageProps<"/report/[id]">) {
  const { id } = await params;
  const view = await getReport(id);
  if (!view) notFound();

  const { session, score, transcript } = view;
  const flagged = transcript.filter((line) => line.flag).length;
  const length = clock(session.duration_seconds);
  const date = session.started_at
    ? new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short" }).format(
        new Date(session.started_at),
      )
    : null;

  return (
    <div className="flex flex-1 flex-col">
      <header className="flex h-[72px] shrink-0 items-center justify-between gap-6 border-b border-b-rule px-8">
        <div className="flex min-w-0 items-center gap-6">
          <span className="display text-u-body shrink-0">
            MockPrep<sup>®</sup>
          </span>
          <h1 className="eyebrow truncate">Scored report</h1>
        </div>
        <div className="flex shrink-0 items-center gap-6">
          <Link href="/dashboard" className="eyebrow hidden sm:block">
            Back to dashboard
          </Link>
          <Link href="/dashboard">
            <Button>Start another round</Button>
          </Link>
        </div>
      </header>

      <main className="grid flex-1 grid-cols-1 gap-12 px-8 py-12 xl:grid-cols-[400px_minmax(0,1fr)]">
        <section aria-labelledby="score-heading" className="flex flex-col">
          <h2 id="score-heading" className="eyebrow">
            Round score
          </h2>

          {score ? (
            <>
              <p className="mt-4 flex items-baseline gap-2">
                <span className="numeric text-u-display font-medium leading-none">
                  {score.overall}
                </span>
                <span className="numeric text-u-body">/100</span>
              </p>

              <div className="mt-4 flex flex-wrap items-center gap-4">
                <p className="eyebrow">
                  {session.title}
                  {date ? (
                    <>
                      {" "}
                      <span aria-hidden>·</span> <time>{date}</time>
                    </>
                  ) : null}
                  {length ? (
                    <>
                      {" "}
                      <span aria-hidden>·</span> <time>{length}</time>
                    </>
                  ) : null}
                </p>
                <PillTag>{session.track}</PillTag>
              </div>

              <ul className="mt-10">
                {breakdownRows.map((row) => (
                  <RuledRow
                    key={row.key}
                    className="py-4"
                    progress={score[row.key]}
                    title={<span className="eyebrow">{row.label}</span>}
                    trailing={
                      <span className="numeric text-u-body font-medium">
                        {score[row.key]}
                      </span>
                    }
                  />
                ))}
              </ul>
            </>
          ) : session.status === "abandoned" ? (
            <div className="mt-4 flex flex-col gap-6">
              <p className="text-u-lg">This round timed out before it was scored.</p>
              <p className="text-u-body max-w-md">
                It sat open for an hour and was closed. The transcript is kept
                below; the score cannot be made now.
              </p>
              <div>
                <Link href="/dashboard">
                  <Button>Start a new round</Button>
                </Link>
              </div>
            </div>
          ) : (
            /* Live, unscored: every answer is in but the scorer was not
               reached. The same affordance as the session screen. */
            <div className="mt-4 flex flex-col gap-6">
              <p className="text-u-lg">This round has not been scored yet.</p>
              <ScoreRetry sessionId={session.id} />
            </div>
          )}
        </section>

        <section aria-labelledby="transcript-heading" className="min-w-0">
          <div className="mb-4 flex items-baseline justify-between gap-6">
            <h2 id="transcript-heading" className="eyebrow">
              Transcript
            </h2>
            <p className="eyebrow numeric">{flagged} flagged</p>
          </div>

          <RuledRowList>
            {transcript.map((line) => (
              <RuledRow
                key={line.id}
                className="py-8"
                scale="ui"
                stackTrailing
                title={line.body}
                meta={
                  <>
                    <time>{clock(line.at_seconds)}</time>{" "}
                    <span aria-hidden>·</span>{" "}
                    {line.speaker === "interviewer" ? "Interviewer" : "You"}
                  </>
                }
                // Reserved on EVERY row, flagged or not. Do not make this
                // conditional: without the empty slot, unflagged utterances
                // wrap at the full column width and flagged ones wrap 176px
                // short, so the transcript's right edge ratchets down the page.
                trailing={
                  <span className="flex w-full justify-end sm:w-44">
                    {line.flag ? (
                      <PillTag>{FLAG_LABELS[line.flag] ?? line.flag}</PillTag>
                    ) : null}
                  </span>
                }
              />
            ))}
          </RuledRowList>
        </section>
      </main>
    </div>
  );
}
