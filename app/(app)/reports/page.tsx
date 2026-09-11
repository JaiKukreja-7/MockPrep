import Link from "next/link";
import { redirect } from "next/navigation";
import { PillTag, RuledRow, RuledRowList } from "@/components/ui";
import { getReports } from "@/lib/data/library";

export const metadata = { title: "Reports — MockPrep" };

export default async function ReportsPage() {
  const reports = await getReports();
  if (!reports) redirect("/sign-in?next=/reports");

  return (
    <>
      <header className="flex h-[72px] shrink-0 items-center justify-between gap-8 border-b border-b-rule px-8">
        <h1 className="text-u-lg font-medium">Reports</h1>
        <p className="eyebrow numeric">{reports.length} scored</p>
      </header>

      <main className="flex flex-1 flex-col px-8 py-12">
        {reports.length > 0 ? (
          <RuledRowList>
            {reports.map((report) => (
              <RuledRow
                key={report.id}
                className="py-10"
                scale="ui"
                stackTrailing
                title={
                  <Link href={`/report/${report.id}`} className="inline-block py-2">{report.title}</Link>
                }
                meta={
                  <>
                    {report.date ? <time>{report.date}</time> : null}
                    {report.date && report.length ? (
                      <>
                        {" "}
                        <span aria-hidden>·</span>{" "}
                      </>
                    ) : null}
                    {report.length ? <time>{report.length}</time> : null}
                  </>
                }
                trailing={
                  <span className="flex items-center justify-between gap-8 sm:justify-start">
                    <span className="flex sm:w-44 sm:justify-center">
                      <PillTag>{report.track}</PillTag>
                    </span>
                    <span className="numeric w-12 text-right text-u-lg">
                      {report.overall}
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
              title="No scored reports yet."
              meta="Finish a round and its report appears here"
            />
          </RuledRowList>
        )}
      </main>
    </>
  );
}
