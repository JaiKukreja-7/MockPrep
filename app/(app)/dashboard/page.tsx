import { redirect } from "next/navigation";
import {
  Button,
  Heatmap,
  PillTag,
  RuledRow,
  RuledRowList,
} from "@/components/ui";
import { getDashboard } from "@/lib/data/dashboard";
import { TYPE_LABEL } from "@/lib/question-types";
import { createClient } from "@/lib/supabase/server";
import { StartRound } from "./start-round";

export const metadata = {
  title: "Dashboard — MockPrep",
};

// Vercel: a server action runs under the segment config of the page that
// posts it, so the limit for startRound lives here. Question generation can walk the 1/2/4/8s ladder on one provider and
// then fail over to another before it answers.
// The platform default would cut it off.
export const maxDuration = 120;

const plural = (n: number, word: string) => (n === 1 ? word : `${word}s`);

const breakdownRows = [
  { label: "Structure", key: "structure" },
  { label: "Specificity", key: "specificity" },
  { label: "Pace", key: "pace" },
] as const;

export default async function DashboardPage() {
  const data = await getDashboard();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: profile } = user
    ? await supabase.from("users").select("is_guest").eq("id", user.id).maybeSingle()
    : { data: null };

  // The proxy already gates this route; this is the belt to its braces, and
  // it narrows the type.
  if (!data) redirect("/sign-in?next=/dashboard");

  const { latest, byType, upNext, recentSessions, focusAreas, heatmap } = data;

  return (
    <>
      <header className="flex h-[72px] shrink-0 items-center border-b border-b-rule px-8">
        <h1 className="text-u-lg font-medium">Dashboard</h1>
      </header>

      <main className="grid flex-1 grid-cols-1 gap-12 px-8 py-12 xl:grid-cols-[400px_minmax(0,1fr)]">
        {/* ---------------------------------------------------- Score panel */}
        <section aria-labelledby="score-heading" className="flex flex-col">
          <h2 id="score-heading" className="eyebrow">
            Last overall score
          </h2>

          {latest ? (
            <>
              <p className="mt-4 flex items-baseline gap-2">
                <span className="numeric text-u-display font-medium leading-none">
                  {latest.overall}
                </span>
                <span className="numeric text-u-body">/100</span>
              </p>

              <ul className="mt-10">
                {breakdownRows.map((row) => (
                  <RuledRow
                    key={row.key}
                    className="py-4"
                    progress={latest[row.key]}
                    title={<span className="eyebrow">{row.label}</span>}
                    trailing={
                      <span className="numeric text-u-body font-medium">
                        {latest[row.key]}
                      </span>
                    }
                  />
                ))}
              </ul>

              {/* Content scores by question type, across every scored round:
                  the same meter treatment, so a weak DSA average reads next
                  to a strong behavioural one at a glance. */}
              {byType.length > 0 ? (
                <div className="mt-10">
                  <h3 className="eyebrow mb-2">By question type</h3>
                  <ul>
                    {byType.map((t) => (
                      <RuledRow
                        key={t.type}
                        className="py-4"
                        progress={t.average}
                        title={<span className="eyebrow">{TYPE_LABEL[t.type]}</span>}
                        meta={`${t.rounds} ${t.rounds === 1 ? "question" : "questions"}`}
                        trailing={
                          <span className="numeric text-u-body font-medium">{t.average}</span>
                        }
                      />
                    ))}
                  </ul>
                </div>
              ) : null}

              <p className="mt-10">
                <a href={`/report/${recentSessions[0]?.id ?? ""}`} className="link inline-block py-2 text-u-body">
                  Read the full report
                </a>
              </p>
            </>
          ) : (
            <p className="mt-4 text-u-lg">
              No scored rounds yet. Your first one takes about twenty minutes.
            </p>
          )}

          <section aria-labelledby="practice-heading" className="mt-12">
            <h2 id="practice-heading" className="eyebrow mb-4">
              Practice
            </h2>
            <Heatmap
              cells={heatmap.cells}
              months={heatmap.months}
              columns={heatmap.columns}
            />
          </section>
        </section>

        {/* ------------------------------------------------ Activity column */}
        <div className="flex min-w-0 flex-col gap-12">
          <section aria-labelledby="upnext-heading">
            <h2 id="upnext-heading" className="eyebrow mb-4">
              Up next
            </h2>
            <StartRound upNext={upNext} isGuest={profile?.is_guest ?? true} />
          </section>

          <section aria-labelledby="recent-heading">
            <h2 id="recent-heading" className="eyebrow mb-4">
              Recent sessions
            </h2>
            {recentSessions.length > 0 ? (
              <RuledRowList>
                {recentSessions.map((session) => (
                  <RuledRow
                    key={session.id}
                    className="py-10"
                    scale="ui"
                    stackTrailing
                    title={session.title}
                    meta={
                      session.date || session.length ? (
                        <>
                          {session.date ? <time>{session.date}</time> : null}
                          {session.date && session.length ? (
                            <>
                              {" "}
                              <span aria-hidden>·</span>{" "}
                            </>
                          ) : null}
                          {session.length ? <time>{session.length}</time> : null}
                        </>
                      ) : null
                    }
                    // Full width below sm, so it wraps under the title
                    // instead of crushing it; the fixed pill column returns
                    // once there is room for it beside the text.
                    trailing={
                      <span className="flex items-center justify-between gap-8 sm:justify-start">
                        <span className="flex sm:w-44 sm:justify-center">
                          <PillTag>{session.track}</PillTag>
                        </span>
                        <span className="numeric w-12 text-right text-u-lg">
                          {session.score ?? "—"}
                        </span>
                      </span>
                    }
                  />
                ))}
              </RuledRowList>
            ) : (
              <RuledRowList>
                <RuledRow
                  className="py-10"
                  scale="ui"
                  title="Nothing here yet."
                  meta="Your scored rounds will land in this list"
                />
              </RuledRowList>
            )}
          </section>

          {focusAreas.length > 0 ? (
            <section aria-labelledby="focus-heading">
              <h2 id="focus-heading" className="eyebrow mb-4">
                What to work on
              </h2>
              <RuledRowList>
                {focusAreas.map((area) => (
                  <RuledRow
                    key={area.flag}
                    className="py-10"
                    scale="ui"
                    title={area.label}
                    // Counts, not points. Attributing points to a habit needs
                    // the scoring model, which is not wired up yet.
                    meta={`${area.flagCount} ${plural(area.flagCount, "flag")} across ${area.sessionCount} ${plural(area.sessionCount, "round")}`}
                    trailing={
                      <Button variant="outline" size="compact">
                        Drill it
                      </Button>
                    }
                  />
                ))}
              </RuledRowList>
            </section>
          ) : null}
        </div>
      </main>
    </>
  );
}
