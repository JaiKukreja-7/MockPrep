import Link from "next/link";
import { redirect } from "next/navigation";
import { PillTag, RuledRow, RuledRowList } from "@/components/ui";
import { getQuestionBank } from "@/lib/data/library";
import type { Track } from "@/lib/supabase/types";

export const metadata = { title: "Question bank — MockPrep" };

const TRACK_VALUES = ["consulting", "engineering", "product", "general"];

export default async function QuestionsPage({
  searchParams,
}: PageProps<"/questions">) {
  const params = await searchParams;
  const raw = typeof params.track === "string" ? params.track : null;
  const track = raw && TRACK_VALUES.includes(raw) ? (raw as Track) : undefined;

  const data = await getQuestionBank(track);
  if (!data) redirect("/sign-in?next=/questions");

  return (
    <>
      <header className="flex h-[72px] shrink-0 items-center justify-between gap-8 border-b border-b-rule px-8">
        <h1 className="text-u-lg font-medium">Question bank</h1>
        <p className="eyebrow numeric">{data.questions.length} questions</p>
      </header>

      <main className="flex flex-1 flex-col gap-8 px-8 py-12">
        {data.tracks.length > 0 ? (
          <nav aria-label="Filter by track" className="flex flex-wrap items-center gap-4">
            <Link href="/questions" aria-current={!track ? "true" : undefined}>
              <PillTag className={!track ? "bg-ink text-ink-inverse" : undefined}>
                All
              </PillTag>
            </Link>
            {data.tracks.map((t) => (
              <Link
                key={t}
                href={`/questions?track=${t}`}
                aria-current={track === t ? "true" : undefined}
              >
                <PillTag
                  className={track === t ? "bg-ink text-ink-inverse" : undefined}
                >
                  {t}
                </PillTag>
              </Link>
            ))}
          </nav>
        ) : null}

        {/* The landing page's ruled index, at display scale: title left, pill
            right, 1px rules between. Same treatment, real rows. */}
        {data.questions.length > 0 ? (
          <RuledRowList>
            {data.questions.map((q) => (
              <RuledRow
                key={q.question}
                title={q.question}
                meta={
                  q.asked > 1 ? (
                    <>
                      Asked <span className="numeric">{q.asked}</span> times
                    </>
                  ) : null
                }
                trailing={<PillTag>{q.track}</PillTag>}
              />
            ))}
          </RuledRowList>
        ) : (
          <RuledRowList>
            <RuledRow
              scale="ui"
              className="py-10"
              title={
                track ? "No questions on this track yet." : "No questions yet."
              }
              meta="Questions appear here once you have run a round"
            />
          </RuledRowList>
        )}
      </main>
    </>
  );
}
