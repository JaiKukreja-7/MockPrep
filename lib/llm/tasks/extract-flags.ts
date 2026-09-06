import "server-only";
import { runTask } from "../index";
import { parseJson } from "../json";
import type { TranscriptFlag } from "@/lib/supabase/types";

const VALID: readonly TranscriptFlag[] = [
  "filler",
  "restated",
  "no_number",
  "rambled",
];

export interface TranscriptLine {
  index: number;
  speaker: "interviewer" | "candidate";
  body: string;
}

export interface ExtractedFlag {
  index: number;
  flag: TranscriptFlag;
}

/**
 * Flags are returned against line indexes rather than timestamps: the model
 * is reliable at "line 3", and unreliable at reproducing "00:38" exactly.
 * The caller maps indexes back to rows.
 */
export async function extractFlags(
  lines: TranscriptLine[],
): Promise<{ flags: ExtractedFlag[]; provider: string }> {
  const candidateLines = lines.filter((l) => l.speaker === "candidate");
  if (candidateLines.length === 0) return { flags: [], provider: "skipped" };

  const numbered = lines
    .map((l) => `[${l.index}] ${l.speaker}: ${l.body}`)
    .join("\n");

  const result = await runTask("flag_extraction", {
    json: true,
    temperature: 0.1,
    system:
      "You mark habits in interview transcripts. Return only JSON. " +
      "No commentary, no markdown fences.",
    user:
      `Mark lines spoken by the candidate that show one of these habits:\n\n` +
      `filler — "um", "like", "I guess", throat-clearing before the point.\n` +
      `restated — repeating the question back instead of answering it.\n` +
      `no_number — a claim about impact with no number attached to it.\n` +
      `rambled — the line runs well past its point.\n\n` +
      `Only flag lines that clearly show the habit. Do not flag the ` +
      `interviewer. Most lines should not be flagged. One flag per line.\n\n` +
      `TRANSCRIPT:\n${numbered}\n\n` +
      `Return exactly this shape:\n` +
      `{"flags": [{"index": 0, "flag": "filler"}]}`,
  });

  const parsed = parseJson<{ flags?: unknown }>(result.text);
  const allowed = new Set(candidateLines.map((l) => l.index));

  const flags: ExtractedFlag[] = Array.isArray(parsed.flags)
    ? parsed.flags
        .map((entry) => entry as Record<string, unknown>)
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => ({
          index: Number(entry.index),
          flag: String(entry.flag) as TranscriptFlag,
        }))
        // Drop hallucinated line numbers, interviewer lines and unknown flags
        // rather than letting them reach a NOT NULL enum column.
        .filter(
          (f) =>
            Number.isInteger(f.index) &&
            allowed.has(f.index) &&
            VALID.includes(f.flag),
        )
    : [];

  return { flags, provider: `${result.provider}/${result.model}` };
}
