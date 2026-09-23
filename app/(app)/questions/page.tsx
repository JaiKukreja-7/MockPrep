import Link from "next/link";
import { redirect } from "next/navigation";
import { PillTag, RuledRow, RuledRowList } from "@/components/ui";
import { TYPE_LABEL } from "@/lib/question-types";
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
            <Link href="/questions" className="inline-flex py-1" aria-current={!track ? "true" : undefined}>
              <PillTag className={!track ? "bg-ink text-ink-inverse" : undefined}>
                All
              </PillTag>
            </Link>
            {data.tracks.map((t) => (
              <Link
                key={t}
                href={`/questions?track=${t}`}
                className="inline-flex py-1"
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
                  <>
                    {TYPE_LABEL[q.type]}
                    {q.topic ? (
                      <>
                        {" "}
                        <span aria-hidden>·</span> {q.topic}
                      </>
                    ) : null}
                    {q.asked > 1 ? (
                      <>
                        {" "}
                        <span aria-hidden>·</span> Asked{" "}
                        <span className="numeric">{q.asked}</span> times
                      </>
                    ) : null}
                  </>
                }
                trailing={
                  <span className="flex items-center gap-4">
                    <PillTag>{q.track}</PillTag>
                    {q.score !== null ? (
                      <span className="numeric text-u-lg font-medium">{q.score}</span>
                    ) : null}
                  </span>
                }
                stackTrailing
                footer={
                  /* The bank was a list with nothing to do. Each question now
                     carries what you said and what a strong answer was —
                     collapsed, same idiom as the report — and a way back to
                     the round it came from. */
                  <div className="mt-4 flex flex-col gap-4">
                    {q.answer || q.modelAnswer ? (
                      <details className="disclosure">
                        <summary className="link eyebrow">
                          {q.answer && q.modelAnswer
                            ? "Your answer, and a strong one"
                            : q.answer
                              ? "Your answer"
                              : "What a strong answer sounds like"}
                        </summary>
                        <div className="mt-4 flex max-w-3xl flex-col gap-6">
                          {q.answer ? (
                            <div>
                              <p className="eyebrow">You said</p>
                              <p className="mt-2 whitespace-pre-line text-u-body">{q.answer}</p>
                            </div>
                          ) : null}
                          {q.modelAnswer ? (
                            <div>
                              <p className="eyebrow">A strong answer</p>
                              <p className="mt-2 whitespace-pre-line text-u-body">{q.modelAnswer}</p>
                            </div>
                          ) : null}
                        </div>
                      </details>
                    ) : null}
                    <p>
                      <Link href={`/report/${q.sessionId}`} className="link inline-block py-1 text-u-body">
                        See the round this came from
                      </Link>
                    </p>
                  </div>
                }
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
