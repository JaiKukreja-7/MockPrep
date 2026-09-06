import { createClient } from "@/lib/supabase/server";
import type { AnalysisRow } from "@/lib/supabase/types";

const dateFormat = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

export interface AnalysisListRow {
  id: string;
  targetRole: string;
  sourceName: string;
  sourceKind: string;
  atsScore: number;
  date: string;
  findingCount: number;
}

export async function getAnalyses(): Promise<AnalysisListRow[] | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data, error } = await supabase
    .from("analyses")
    .select("id, target_role, source_name, source_kind, ats_score, findings, created_at")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: row.id,
    targetRole: row.target_role,
    sourceName: row.source_name,
    sourceKind: row.source_kind,
    atsScore: row.ats_score,
    date: dateFormat.format(new Date(row.created_at)),
    findingCount: Array.isArray(row.findings) ? row.findings.length : 0,
  }));
}

export async function getAnalysis(id: string): Promise<AnalysisRow | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("analyses")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return data;
}
