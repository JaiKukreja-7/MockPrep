/**
 * Pulls JSON out of a model response.
 *
 * Every model on these routes is a reasoning model, and they variously wrap
 * output in ```json fences, prefix it with <think> blocks, or add a sentence
 * of preamble even when asked for JSON only. Strict JSON.parse fails on all
 * three, so this strips the wrappers and then scans for the first balanced
 * object or array rather than trusting the model to have behaved.
 */
export function parseJson<T>(raw: string): T {
  let text = raw.trim();

  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();

  try {
    return JSON.parse(text) as T;
  } catch {
    // fall through to the scanner
  }

  const extracted = firstBalanced(text);
  if (extracted === null) {
    throw new Error(
      `Model did not return JSON. First 200 chars: ${raw.slice(0, 200)}`,
    );
  }
  return JSON.parse(extracted) as T;
}

/** Finds the first complete {...} or [...], ignoring braces inside strings. */
function firstBalanced(text: string): string | null {
  const start = text.search(/[{[]/);
  if (start === -1) return null;

  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
