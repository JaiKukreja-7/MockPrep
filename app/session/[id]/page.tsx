import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/data/session";
import { LiveRound } from "./live-round";

export const metadata = { title: "Live session — MockPrep" };

export default async function SessionPage({ params }: PageProps<"/session/[id]">) {
  const { id } = await params;
  const view = await getSession(id);

  if (!view) notFound();
  // A finished round belongs on its report, not back in the interview.
  if (view.session.status === "scored") redirect(`/report/${id}`);

  return <LiveRound view={view} />;
}
