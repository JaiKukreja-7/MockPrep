import { describe, expect, it, vi } from "vitest";

// runTask is the network; everything else in extractFlags is the validator
// under test.
const runTask = vi.fn();
vi.mock("@/lib/llm/index", () => ({ runTask: (...args: unknown[]) => runTask(...args) }));

const { extractFlags } = await import("@/lib/llm/tasks/extract-flags");

const lines = [
  { index: 0, speaker: "interviewer" as const, body: "Tell me about a time…" },
  { index: 1, speaker: "candidate" as const, body: "So, um, I guess…" },
  { index: 2, speaker: "interviewer" as const, body: "And the result?" },
  { index: 3, speaker: "candidate" as const, body: "It made a big difference." },
];

describe("extractFlags", () => {
  it("keeps only flags on candidate lines that exist, with known flag names", async () => {
    runTask.mockResolvedValueOnce({
      provider: "groq",
      model: "m",
      text: JSON.stringify({
        flags: [
          { index: 1, flag: "filler" }, // valid
          { index: 3, flag: "no_number" }, // valid
          { index: 0, flag: "filler" }, // interviewer line
          { index: 99, flag: "filler" }, // hallucinated line
          { index: "1", flag: "rambled" }, // string index: coerced, still line 1
          { index: 1.5, flag: "filler" }, // not an integer
          { index: 3, flag: "shouting" }, // unknown flag
          { index: -1, flag: "filler" }, // negative
          null, // junk
          "filler", // junk
        ],
      }),
    });

    const { flags, provider } = await extractFlags(lines);
    expect(flags).toEqual([
      { index: 1, flag: "filler" },
      { index: 3, flag: "no_number" },
      { index: 1, flag: "rambled" },
    ]);
    expect(provider).toBe("groq/m");
  });

  it("returns no flags when the model omits the array or wraps it in prose", async () => {
    runTask.mockResolvedValueOnce({ provider: "groq", model: "m", text: "<think>hmm</think>```json\n{\"notes\":\"none\"}\n```" });
    expect((await extractFlags(lines)).flags).toEqual([]);
  });

  it("skips the model entirely when there are no candidate lines", async () => {
    runTask.mockClear();
    const result = await extractFlags(lines.filter((l) => l.speaker === "interviewer"));
    expect(result).toEqual({ flags: [], provider: "skipped" });
    expect(runTask).not.toHaveBeenCalled();
  });
});
