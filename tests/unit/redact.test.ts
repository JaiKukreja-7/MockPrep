import { describe, expect, it } from "vitest";
import { redactContactDetails } from "@/lib/resume/redact";

/**
 * The table verified by hand when the redaction was written, now fixed.
 * Left column is what a model might quote from a resume; right is what may
 * reach the database.
 */
const REDACTED: Array<[input: string, expected: string]> = [
  ["Call 0400 000 000 today", "Call [phone] today"],
  ["Phone: (03) 9000 0000", "Phone: [phone]"],
  ["Mobile +61 400 000 000", "Mobile [phone]"],
  ["Cell +1 (555) 123-4567", "Cell [phone]"],
  ["Tel 0412-345-678", "Tel [phone]"],
  ["Email jane.doe@example.com for details", "Email [email] for details"],
  ["JANE+cv@sub.example.co.uk", "[email]"],
  ["See https://example.com/cv for more", "See [url] for more"],
  ["Portfolio: www.janedoe.dev", "Portfolio: [url]"],
  ["linkedin.com/in/janedoe", "[url]"],
  ["github.com/janedoe/project", "[url]"],
];

const PRESERVED: string[] = [
  "Analyst, 2019–2023",
  "Analyst 2019-2023",
  "WAM 84.5 across the degree",
  "WAM 78",
  "Cut costs by $340,000 a year",
  "Grew revenue to $1.2M",
  "Jan 2020 – Mar 2023",
  "GPA 3.8/4.0",
  "Increased conversion 25% in Q3 2024",
  "Led a team of 12 across 3 offices",
];

describe("redactContactDetails", () => {
  it.each(REDACTED)("redacts: %s", (input, expected) => {
    expect(redactContactDetails(input)).toBe(expected);
  });

  it.each(PRESERVED)("preserves: %s", (input) => {
    expect(redactContactDetails(input)).toBe(input);
  });

  it("handles a sentence with all three kinds at once", () => {
    const input =
      "Contact Jane on 0400 000 000, jane@example.com or linkedin.com/in/jane (2019–2023).";
    expect(redactContactDetails(input)).toBe(
      "Contact Jane on [phone], [email] or [url] (2019–2023).",
    );
  });

  it("does not leave a stray bracket behind on the (03) form", () => {
    expect(redactContactDetails("(03) 9000 0000")).not.toContain("(");
  });
});
