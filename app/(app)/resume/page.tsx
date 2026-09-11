import Link from "next/link";
import { redirect } from "next/navigation";
import { PillTag, RuledRow, RuledRowList } from "@/components/ui";
import { getAnalyses } from "@/lib/data/analyses";
import { UploadForm } from "./upload-form";

export const metadata = { title: "Resume — MockPrep" };

export default async function ResumePage() {
  const analyses = await getAnalyses();
  if (!analyses) redirect("/sign-in?next=/resume");

  return (
    <>
      <header className="flex h-[72px] shrink-0 items-center justify-between gap-8 border-b border-b-rule px-8">
        <h1 className="text-u-lg font-medium">Resume</h1>
        <p className="eyebrow numeric">{analyses.length} analysed</p>
      </header>

      <main className="flex flex-1 flex-col gap-12 px-8 py-12">
        <section aria-labelledby="upload-heading">
          <h2 id="upload-heading" className="eyebrow mb-4">
            Check a resume
          </h2>
          <UploadForm />
        </section>

        <section aria-labelledby="past-heading">
          <h2 id="past-heading" className="eyebrow mb-4">
            Past checks
          </h2>
          {analyses.length > 0 ? (
            <RuledRowList>
              {analyses.map((a) => (
                <RuledRow
                  key={a.id}
                  className="py-10"
                  scale="ui"
                  stackTrailing
                  title={<Link href={`/resume/${a.id}`} className="inline-block py-2">{a.targetRole}</Link>}
                  meta={
                    <>
                      <time>{a.date}</time> <span aria-hidden>·</span>{" "}
                      {a.sourceName} <span aria-hidden>·</span>{" "}
                      <span className="numeric">{a.findingCount}</span>{" "}
                      {a.findingCount === 1 ? "finding" : "findings"}
                    </>
                  }
                  trailing={
                    <span className="flex items-center justify-between gap-8 sm:justify-start">
                      <span className="flex sm:w-44 sm:justify-center">
                        <PillTag>{a.sourceKind}</PillTag>
                      </span>
                      <span className="numeric w-12 text-right text-u-lg">
                        {a.atsScore}
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
                title="Nothing checked yet."
                meta="Upload a resume and its audit lands in this list"
              />
            </RuledRowList>
          )}
        </section>
      </main>
    </>
  );
}
