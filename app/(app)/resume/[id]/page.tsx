import Link from "next/link";
import { notFound } from "next/navigation";
import { PillTag, RuledRow, RuledRowList } from "@/components/ui";
import { getAnalysis } from "@/lib/data/analyses";
import type { FindingCategory } from "@/lib/supabase/types";

export const metadata = { title: "Resume check — MockPrep" };

const CATEGORY_LABELS: Record<FindingCategory, string> = {
  parseability: "Parsing",
  keywords: "Keywords",
  formatting: "Formatting",
  bullets: "Bullets",
};

const breakdownRows = [
  { label: "Parseability", key: "parseability" },
  { label: "Keyword coverage", key: "keyword_coverage" },
  { label: "Formatting", key: "formatting" },
  { label: "Bullet strength", key: "bullet_strength" },
] as const;

export default async function AnalysisPage({
  params,
}: PageProps<"/resume/[id]">) {
  const { id } = await params;
  const analysis = await getAnalysis(id);
  if (!analysis) notFound();

  const { keywords, findings } = analysis;

  return (
    <>
      <header className="flex h-[72px] shrink-0 items-center justify-between gap-8 border-b border-b-rule px-8">
        <h1 className="text-u-lg font-medium">Resume check</h1>
        <Link href="/resume" className="link eyebrow">
          All checks
        </Link>
      </header>

      <main className="grid flex-1 grid-cols-1 gap-12 px-8 py-12 xl:grid-cols-[400px_minmax(0,1fr)]">
        {/* -------------------------------------------------- Score panel
            Same treatment as a round's report: one big number, then the
            sub-scores as meters drawn along each row's own rule. No colour —
            rank and size carry it. */}
        <section aria-labelledby="score-heading" className="flex flex-col">
          <h2 id="score-heading" className="eyebrow">
            ATS score
          </h2>

          <p className="mt-4 flex items-baseline gap-2">
            <span className="numeric text-u-display font-medium leading-none">
              {analysis.ats_score}
            </span>
            <span className="numeric text-u-body">/100</span>
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-4">
            <p className="eyebrow">
              {analysis.target_role} <span aria-hidden>·</span>{" "}
              {analysis.source_name}
            </p>
            <PillTag>{analysis.source_kind}</PillTag>
          </div>

          <ul className="mt-10">
            {breakdownRows.map((row) => (
              <RuledRow
                key={row.key}
                className="py-4"
                progress={analysis[row.key]}
                title={<span className="eyebrow">{row.label}</span>}
                trailing={
                  <span className="numeric text-u-body font-medium">
                    {analysis[row.key]}
                  </span>
                }
              />
            ))}
          </ul>

          {keywords.missing.length > 0 ? (
            <div className="mt-12">
              <h3 className="eyebrow mb-4">Missing keywords</h3>
              <div className="flex flex-wrap gap-3">
                {keywords.missing.map((word) => (
                  <PillTag key={word}>{word}</PillTag>
                ))}
              </div>
            </div>
          ) : null}

          {keywords.matched.length > 0 ? (
            <div className="mt-10">
              <h3 className="eyebrow mb-4">
                Matched <span className="numeric">{keywords.matched.length}</span>
              </h3>
              <p className="text-u-body">{keywords.matched.join(", ")}</p>
            </div>
          ) : null}
        </section>

        {/* ---------------------------------------------------- Findings */}
        <section aria-labelledby="findings-heading" className="min-w-0">
          <div className="mb-4 flex items-baseline justify-between gap-6">
            <h2 id="findings-heading" className="eyebrow">
              Findings
            </h2>
            <p className="eyebrow numeric">{findings.length} to fix</p>
          </div>

          {findings.length > 0 ? (
            <RuledRowList>
              {findings.map((finding, i) => (
                <RuledRow
                  key={`${finding.category}-${i}`}
                  className="py-8"
                  scale="ui"
                  stackTrailing
                  title={finding.title}
                  meta={
                    <>
                      {finding.detail}
                      {finding.excerpt ? (
                        <>
                          {" "}
                          <span aria-hidden>·</span> “{finding.excerpt}”
                        </>
                      ) : null}
                    </>
                  }
                  // Reserved on every row, flagged or not, so the detail text
                  // wraps at one consistent width down the page.
                  trailing={
                    <span className="flex w-full justify-end sm:w-44">
                      <PillTag>{CATEGORY_LABELS[finding.category]}</PillTag>
                    </span>
                  }
                />
              ))}
            </RuledRowList>
          ) : (
            <RuledRowList>
              <RuledRow
                className="py-8"
                scale="ui"
                title="Nothing flagged."
                meta="The audit found no blocking issues for this role"
              />
            </RuledRowList>
          )}
        </section>
      </main>
    </>
  );
}
