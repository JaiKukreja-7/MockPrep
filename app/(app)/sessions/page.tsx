import Link from "next/link";
import { redirect } from "next/navigation";
import {
  PillTag,
  RuledRow,
  RuledRowList,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@/components/ui";
import { getSessions } from "@/lib/data/library";
import type { Track } from "@/lib/supabase/types";

export const metadata = { title: "Sessions — MockPrep" };

const TRACK_VALUES = ["consulting", "engineering", "product", "general"];

export default async function SessionsPage({
  searchParams,
}: PageProps<"/sessions">) {
  const params = await searchParams;
  const raw = typeof params.track === "string" ? params.track : null;
  const track = raw && TRACK_VALUES.includes(raw) ? (raw as Track) : undefined;

  const data = await getSessions(track);
  if (!data) redirect("/sign-in?next=/sessions");

  return (
    <>
      <header className="flex h-[72px] shrink-0 items-center justify-between gap-8 border-b border-b-rule px-8">
        <h1 className="text-u-lg font-medium">Sessions</h1>
        <p className="eyebrow numeric">{data.total} in total</p>
      </header>

      <main className="flex flex-1 flex-col gap-8 px-8 py-12">
        {/* Filters are links, not state — the track lives in the URL so a
            filtered list can be shared and reloaded. */}
        {data.tracks.length > 0 ? (
          <nav aria-label="Filter by track" className="flex flex-wrap items-center gap-4">
            <Link href="/sessions" className="inline-flex py-1" aria-current={!track ? "true" : undefined}>
              <PillTag
                className={!track ? "bg-ink text-ink-inverse" : undefined}
              >
                All
              </PillTag>
            </Link>
            {data.tracks.map((t) => (
              <Link
                key={t}
                href={`/sessions?track=${t}`}
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

        {data.rows.length > 0 ? (
          /* The Table primitive, not ruled rows: eight columns of which five
             are numeric. Rows would push the sub-scores into a second line
             and lose the column alignment that makes them comparable. */
          <Table>
            <TableHead>
              <TableRow>
                <TableHeaderCell>Round</TableHeaderCell>
                <TableHeaderCell>Track</TableHeaderCell>
                <TableHeaderCell>Date</TableHeaderCell>
                <TableHeaderCell>Status</TableHeaderCell>
                <TableHeaderCell numeric>Length</TableHeaderCell>
                <TableHeaderCell numeric>Structure</TableHeaderCell>
                <TableHeaderCell numeric>Specificity</TableHeaderCell>
                <TableHeaderCell numeric>Pace</TableHeaderCell>
                <TableHeaderCell numeric>Score</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {data.rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    {row.overall !== null ? (
                      <Link href={`/report/${row.id}`} className="inline-block py-2">{row.title}</Link>
                    ) : (
                      row.title
                    )}
                  </TableCell>
                  <TableCell meta>{row.track}</TableCell>
                  <TableCell meta>
                    {row.date ? <time>{row.date}</time> : "—"}
                  </TableCell>
                  <TableCell meta>{row.status}</TableCell>
                  <TableCell numeric>
                    {row.length ? <time>{row.length}</time> : "—"}
                  </TableCell>
                  <TableCell numeric>{row.structure ?? "—"}</TableCell>
                  <TableCell numeric>{row.specificity ?? "—"}</TableCell>
                  <TableCell numeric>{row.pace ?? "—"}</TableCell>
                  <TableCell numeric>{row.overall ?? "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <RuledRowList>
            <RuledRow
              className="py-10"
              scale="ui"
              title={track ? "No rounds on this track yet." : "No rounds yet."}
              meta="Every round you finish lands in this list"
            />
          </RuledRowList>
        )}
      </main>
    </>
  );
}
