"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { OUTAGE_MESSAGE } from "@/lib/supabase/outage";
import { currentUser } from "@/lib/supabase/user";
import { consumeQuota, refundQuota } from "@/lib/llm/quota";
import { describeLlmFailure } from "@/lib/llm/user-message";
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
  const { user, outage } = await currentUser(supabase);
  if (outage) return { error: OUTAGE_MESSAGE };
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

  // Parsed in memory. `text` is never written anywhere: it goes to the
  // analyser and falls out of scope with this function. Extraction runs
  // before the quota is charged: a scan that yields nothing costs no
  // provider call, so it should cost no request either.
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

  const quota = await consumeQuota(1);
  if (!quota.allowed) {
    return {
      error: `Daily limit reached — ${quota.used} of ${quota.cap} used today.`,
    };
  }

  let analysis;
  try {
    analysis = await analyseResume({ text, targetRole });
  } catch (error) {
    await refundQuota(1);
    return {
      error: describeLlmFailure(
        error,
        "Analysis did not go through",
        "Try again in a minute — you have not been charged.",
      ),
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
    await refundQuota(1);
    return { error: writeError?.message ?? "Could not save the analysis." };
  }

  revalidatePath("/resume");
  redirect(`/resume/${row.id}`);
}
