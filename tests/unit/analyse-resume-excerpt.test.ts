import { describe, expect, it, vi } from "vitest";

const runTask = vi.fn();
vi.mock("@/lib/llm/index", () => ({ runTask: (...args: unknown[]) => runTask(...args) }));

const { analyseResume } = await import("@/lib/llm/tasks/analyse-resume");

/**
 * Redaction must run before truncation. An excerpt is capped at 160 chars;
 * an email that starts at char 150 would be cut in half by a truncate-first
 * implementation, leaving "jane.doe@exa" — which the email pattern no longer
 * matches, so the fragment would be stored.
 */
describe("analyseResume excerpt handling", () => {
  it("redacts an email at position 150 of a 200-char excerpt, then truncates to 160", async () => {
    const email = "jane.doe@example.com";
    const excerpt = "x".repeat(150) + email + "y".repeat(200 - 150 - email.length);
    expect(excerpt).toHaveLength(200);

    // The control: truncate-first would have shipped the fragment.
    expect(excerpt.slice(0, 160)).toContain("jane.doe@e");

    runTask.mockResolvedValueOnce({
      provider: "groq",
      model: "m",
      text: JSON.stringify({
        parseability: 80,
        keyword_coverage: 70,
        formatting: 60,
        bullet_strength: 50,
        keywords: { matched: ["a"], missing: ["b"] },
        findings: [{ category: "formatting", title: "Contact line", detail: "d", excerpt }],
      }),
    });

    const analysis = await analyseResume({
      text: "resume body",
      targetRole: "Analyst",
    });

    const stored = analysis.findings[0].excerpt ?? "";
    expect(stored).toContain("[email]");
    expect(stored).not.toContain("jane");
    expect(stored).not.toContain("@");
    expect(stored.length).toBeLessThanOrEqual(160);
  });

  it("stores null rather than an empty excerpt, and derives the overall from the four scores", async () => {
    runTask.mockResolvedValueOnce({
      provider: "groq",
      model: "m",
      text: JSON.stringify({
        parseability: 100,
        keyword_coverage: 50,
        formatting: 50,
        bullet_strength: 0,
        keywords: {},
        findings: [{ category: "bullets", title: "t", detail: "d", excerpt: "   " }],
      }),
    });
    const analysis = await analyseResume({
      text: "resume body",
      targetRole: "Analyst",
    });
    expect(analysis.findings[0].excerpt).toBeNull();
    expect(analysis.atsScore).toBe(50);
  });
});
