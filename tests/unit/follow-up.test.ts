import { describe, expect, it, vi } from "vitest";

/**
 * The follow-up prompt and the probe sanitiser, against the real module with
 * only runTask mocked. The cap — one per question, in both loops — is in
 * follow-up-cap.test.ts, which mocks this module.
 */

const runTask = vi.fn();
vi.mock("@/lib/llm/index", () => ({ runTask: (...a: unknown[]) => runTask(...a) }));

const { buildFollowUpPrompt, followUp, sanitiseProbe } = await import("@/lib/llm/tasks/follow-up");

describe("the follow-up prompt", () => {
  const { system, user } = buildFollowUpPrompt({
    type: "dsa",
    level: "fresher",
    question: "Given an array, find two numbers that sum to a target.",
    answer: "I would use a loop.",
  });

  it("frames it as one optional probe, JSON only", () => {
    expect(system).toMatch(/ONE probing follow-up/);
    expect(system).toMatch(/Return only JSON/);
    expect(user).toMatch(/\{"probe": "\.\.\." \}\s+or\s+\{"probe": null\}/);
  });

  it("names the gaps that matter for the question's type", () => {
    expect(user).toMatch(/dsa question/);
    expect(user).toMatch(/no stated time or space complexity/);
    expect(user).toMatch(/empty input/);
    const design = buildFollowUpPrompt({ type: "system_design", level: "junior", question: "q", answer: "a" }).user;
    expect(design).toMatch(/no trade-off considered/);
    expect(design).not.toMatch(/time or space complexity/);
  });

  it("gives the examples the interviewer would actually say and caps the length", () => {
    expect(user).toMatch(/"What is the time complexity of that\?"/);
    expect(user).toMatch(/"What happens if the input is empty\?"/);
    expect(user).toMatch(/at most 25 words, one question mark/);
  });

  it("says a solid answer gets nothing", () => {
    expect(user).toMatch(/A solid answer gets no follow-up/);
  });
});

describe("sanitiseProbe", () => {
  it.each([
    [null, null],
    [undefined, null],
    ["", null],
    ["   ", null],
    ["null", null],
    ["None", null],
    [42, null],
    ["What is the time complexity?", "What is the time complexity?"],
    ['"What happens if the input is empty?"', "What happens if the input is empty?"],
    ["What is the complexity? And what about space? And edge cases?", "What is the complexity?"],
    ["Interesting. What breaks it?", "Interesting. What breaks it?"],
    ["x".repeat(230) + "?", null],
  ])("%j → %j", (input, expected) => {
    expect(sanitiseProbe(input)).toBe(expected);
  });
});

describe("followUp", () => {
  it("returns the probe the model gave, cleaned", async () => {
    runTask.mockResolvedValueOnce({ provider: "groq", model: "m", text: '{"probe": "What is the time complexity? Also…"}' });
    const out = await followUp({ type: "dsa", level: "fresher", question: "q", answer: "a" });
    expect(out.probe).toBe("What is the time complexity?");
    expect(out.provider).toBe("groq/m");
  });

  it("returns null when the model declines", async () => {
    runTask.mockResolvedValueOnce({ provider: "groq", model: "m", text: '{"probe": null}' });
    expect((await followUp({ type: "dsa", level: "fresher", question: "q", answer: "a" })).probe).toBeNull();
  });
});
