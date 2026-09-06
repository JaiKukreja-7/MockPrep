import "server-only";
import { runTask } from "../index";
import { parseJson } from "../json";

export type FindingCategory =
  | "parseability"
  | "keywords"
  | "formatting"
  | "bullets";

const CATEGORIES: readonly FindingCategory[] = [
  "parseability",
  "keywords",
  "formatting",
  "bullets",
];

export interface Finding {
  category: FindingCategory;
  title: string;
  detail: string;
  /** A short quote showing the problem. Truncated hard — see below. */
  excerpt: string | null;
}

export interface ResumeAnalysis {
  atsScore: number;
  parseability: number;
  keywordCoverage: number;
  formatting: number;
  bulletStrength: number;
  keywords: { matched: string[]; missing: string[] };
  findings: Finding[];
  provider: string;
}

/**
 * Caps on what comes back, which are also the caps on what gets stored.
 *
 * A finding has to be able to point at the line it is about, so excerpts
 * exist — but eight findings of 160 characters is roughly 1.3KB, far short of
 * a reconstructable copy of the document. Raising these raises how much of a
 * stranger's resume the database keeps.
 */
const MAX_FINDINGS = 8;
const MAX_EXCERPT_CHARS = 160;
const MAX_KEYWORDS = 12;

const clamp = (n: unknown): number => {
  const value = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
};

const strings = (v: unknown, limit: number): string[] =>
  Array.isArray(v)
    ? v
        .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        .map((s) => s.trim())
        .slice(0, limit)
    : [];

/**
 * Audits a resume for ATS compatibility.
 *
 * Routed to `resume_analysis`, which is the one task marked `sensitive` — see
 * lib/llm/routing.ts, where the route table refuses at import to send this
 * anywhere that may train on submitted content. A resume is the most
 * identifying thing a user hands over here.
 */
export async function analyseResume({
  text,
  targetRole,
}: {
  text: string;
  targetRole: string;
}): Promise<ResumeAnalysis> {
  const result = await runTask("resume_analysis", {
    json: true,
    temperature: 0.2,
    system:
      "You audit resumes the way an applicant tracking system and a hiring " +
      "screener would. You are specific and unsentimental, and you never " +
      "flatter. Return only JSON — no commentary, no markdown fences.",
    user:
      `TARGET ROLE: ${targetRole}\n\n` +
      `RESUME TEXT:\n${text}\n\n` +
      `Score each 0-100:\n` +
      `parseability — would an ATS read this cleanly? Standard section ` +
      `headings, contact details findable, no evidence of tables, columns or ` +
      `graphics that scramble extraction.\n` +
      `keyword_coverage — does it carry the words a recruiter or an ATS would ` +
      `search for this role?\n` +
      `formatting — consistent dates, tense and punctuation; no walls of text.\n` +
      `bullet_strength — do bullets open with a verb and land a measurable ` +
      `result, or are they vague and duty-shaped?\n\n` +
      `List the keywords a posting for this role would expect, split into ` +
      `matched and missing, at most ${MAX_KEYWORDS} each.\n\n` +
      `Then at most ${MAX_FINDINGS} findings, worst first. Each finding:\n` +
      `  category: one of parseability | keywords | formatting | bullets\n` +
      `  title:   one short imperative sentence, sentence case\n` +
      `  detail:  one sentence on why it costs them\n` +
      `  excerpt: a SHORT quote from the resume showing the problem, or null\n\n` +
      `Return exactly this shape:\n` +
      `{"parseability":0,"keyword_coverage":0,"formatting":0,` +
      `"bullet_strength":0,"keywords":{"matched":[],"missing":[]},` +
      `"findings":[{"category":"bullets","title":"...","detail":"...","excerpt":null}]}`,
  });

  const parsed = parseJson<Record<string, unknown>>(result.text);

  const parseability = clamp(parsed.parseability);
  const keywordCoverage = clamp(parsed.keyword_coverage);
  const formatting = clamp(parsed.formatting);
  const bulletStrength = clamp(parsed.bullet_strength);

  const rawKeywords = (parsed.keywords ?? {}) as Record<string, unknown>;

  const findings: Finding[] = Array.isArray(parsed.findings)
    ? parsed.findings
        .map((entry) => entry as Record<string, unknown>)
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => ({
          category: CATEGORIES.includes(entry.category as FindingCategory)
            ? (entry.category as FindingCategory)
            : "formatting",
          title: typeof entry.title === "string" ? entry.title.trim() : "",
          detail: typeof entry.detail === "string" ? entry.detail.trim() : "",
          excerpt:
            typeof entry.excerpt === "string" && entry.excerpt.trim()
              ? entry.excerpt.trim().slice(0, MAX_EXCERPT_CHARS)
              : null,
        }))
        .filter((f) => f.title.length > 0)
        .slice(0, MAX_FINDINGS)
    : [];

  return {
    // Derived, not asked of the model: an overall it invents separately can
    // contradict its own sub-scores, and the screen leans on rank.
    atsScore: Math.round(
      (parseability + keywordCoverage + formatting + bulletStrength) / 4,
    ),
    parseability,
    keywordCoverage,
    formatting,
    bulletStrength,
    keywords: {
      matched: strings(rawKeywords.matched, MAX_KEYWORDS),
      missing: strings(rawKeywords.missing, MAX_KEYWORDS),
    },
    findings,
    provider: `${result.provider}/${result.model}`,
  };
}
