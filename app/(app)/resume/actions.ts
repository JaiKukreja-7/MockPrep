"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { consumeQuota } from "@/lib/llm/quota";
import { analyseResume } from "@/lib/llm/tasks/analyse-resume";
import { extractResume, ResumeExtractionError } from "@/lib/resume/extract";

export interface AnalyseState {
  error?: string;
}

export async function analyseResumeUpload(
  _prev: AnalyseState,
  formData: FormData,
): Promise<AnalyseState> {
  const file = formData.get("resume");
  const targetRole =
    String(formData.get("role") ?? "").trim() || "Graduate analyst";

  if (!(file instanceof File) || file.size === 0) {
    return { error: "Choose a PDF or DOCX to analyse." };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Sign in to analyse a resume." };

  // Uploads need a real account. The restrictive RLS policy on analyses
  // rejects a guest's insert regardless, but failing here turns a policy
  // violation into a sentence someone can read.
  const { data: profile } = await supabase
    .from("users")
    .select("is_guest")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile || profile.is_guest) {
    return {
      error: "Resume analysis needs an account. Add an email to unlock it.",
    };
  }

  const quota = await consumeQuota(1);
  if (!quota.allowed) {
    return {
      error: `Daily limit reached — ${quota.used} of ${quota.cap} used today.`,
    };
  }

  // Parsed in memory. `text` is never written anywhere: it goes to the
  // analyser and falls out of scope with this function.
  let text: string;
  let kind: "pdf" | "docx";
  try {
    ({ text, kind } = await extractResume(file));
  } catch (error) {
    return {
      error:
        error instanceof ResumeExtractionError
          ? error.message
          : "That file could not be read.",
    };
  }

  let analysis;
  try {
    analysis = await analyseResume({ text, targetRole });
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? `Analysis failed: ${error.message}`
          : "Analysis failed.",
    };
  }

  const { data: row, error: writeError } = await supabase
    .from("analyses")
    .insert({
      user_id: user.id,
      kind: "resume",
      target_role: targetRole,
      source_name: file.name,
      source_kind: kind,
      // The length, not the text.
      source_chars: text.length,
      ats_score: analysis.atsScore,
      parseability: analysis.parseability,
      keyword_coverage: analysis.keywordCoverage,
      formatting: analysis.formatting,
      bullet_strength: analysis.bulletStrength,
      keywords: analysis.keywords,
      findings: analysis.findings,
    })
    .select("id")
    .single();

  if (writeError || !row) {
    return { error: writeError?.message ?? "Could not save the analysis." };
  }

  revalidatePath("/resume");
  redirect(`/resume/${row.id}`);
}
