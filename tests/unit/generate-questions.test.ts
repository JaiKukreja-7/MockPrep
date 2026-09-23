import { describe, expect, it, vi } from "vitest";

const runTask = vi.fn();
vi.mock("@/lib/llm/index", () => ({ runTask: (...a: unknown[]) => runTask(...a) }));

const {
  buildQuestionPrompt,
  generateQuestions,
  planRound,
  ROUND_PLAN,
  DSA_TOPICS,
  CS_TOPICS,
  FOCUS_BRIEF,
} = await import("@/lib/llm/tasks/generate-questions");

/** A deterministic "random": returns the values in order, then repeats the last. */
const seq = (...values: number[]) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
};

describe("the round plan", () => {
  it("engineering is two DSA problems, one fundamentals question and one system design, in that order", () => {
    expect(ROUND_PLAN.engineering).toEqual(["dsa", "dsa", "cs_fundamentals", "system_design"]);
  });

  it("the other tracks keep three questions with a behavioural one last", () => {
    for (const track of ["consulting", "product", "general"] as const) {
      expect(ROUND_PLAN[track]).toHaveLength(3);
      expect(ROUND_PLAN[track].at(-1)).toBe("behavioural");
    }
  });

  it("draws two distinct DSA topics from the level's bucket and one CS topic", () => {
    const plan = planRound("engineering", "intern", seq(0, 0, 0));
    expect(plan.map((s) => s.type)).toEqual(ROUND_PLAN.engineering);
    const dsa = plan.filter((s) => s.type === "dsa").map((s) => s.topic);
    expect(dsa).toEqual(["arrays", "strings"]); // 0 → first, then first of the rest
    expect(new Set(dsa).size).toBe(2);
    for (const t of dsa) expect(DSA_TOPICS.intern).toContain(t);
    expect(CS_TOPICS).toContain(plan[2].topic);
    expect(plan[3].topic).toBeNull();
  });

  it("the DSA buckets widen with level: no DP for interns, no bare arrays at 1–3 years", () => {
    expect(DSA_TOPICS.intern).not.toContain("dynamic programming");
    expect(DSA_TOPICS.intern).not.toContain("graphs");
    expect(DSA_TOPICS.junior).toContain("dynamic programming");
    expect(DSA_TOPICS.junior).not.toContain("arrays");
    expect(DSA_TOPICS.fresher).toContain("two pointers");
  });

  it("non-engineering plans carry no topics", () => {
    expect(planRound("general", "fresher").every((s) => s.topic === null)).toBe(true);
  });
});

describe("the generation prompt", () => {
  const plan = planRound("engineering", "fresher", seq(0.99, 0, 0.5));
  const { system, user } = buildQuestionPrompt({ track: "engineering", role: "Backend engineer", level: "fresher", plan });

  it("asks for JSON only", () => {
    expect(system).toMatch(/Return only JSON/);
    expect(user).toMatch(/\{"questions":\[\{"type":"dsa","topic":"two pointers","question":"\.\.\."\}\]\}/);
  });

  it("names the role, the track and the level's brief", () => {
    expect(user).toMatch(/interviewing for "Backend engineer" in software engineering/);
    expect(user).toMatch(/Pitch every question at a fresher: final year or just graduated/);
  });

  it("lists the four slots in plan order, each with its type and topic", () => {
    const slotLines = user.split("\n").filter((l) => /^\d\. type "/.test(l));
    expect(slotLines).toHaveLength(4);
    expect(slotLines[0]).toMatch(/^1\. type "dsa" on (arrays|strings|hashing|two pointers|trees|graphs):/);
    expect(slotLines[1]).toMatch(/^2\. type "dsa" on /);
    expect(slotLines[2]).toMatch(/^3\. type "cs_fundamentals" on (operating systems|DBMS|networks|OOP):/);
    expect(slotLines[3]).toMatch(/^4\. type "system_design":/);
    expect(slotLines[0]).not.toBe(slotLines[1]);
  });

  it("asks DSA questions the way a phone screen does: approach, complexity, what breaks it, no code", () => {
    expect(user).toMatch(/walk me through your approach, then the time and space complexity, then what breaks it/);
    expect(user).toMatch(/No code is expected/);
    expect(user).toMatch(/state the problem completely, including a tiny example, and end by asking for the approach and its complexity/);
  });

  it("scales system design and fundamentals with the level", () => {
    const intern = buildQuestionPrompt({ track: "engineering", role: "x", level: "intern", plan }).user;
    const junior = buildQuestionPrompt({ track: "engineering", role: "x", level: "junior", plan }).user;
    expect(intern).toMatch(/naming the main components of a small app/);
    expect(junior).toMatch(/has to scale and has to choose between options/);
    expect(junior).toMatch(/indexing, concurrency, failure modes/);
  });

  it("a behavioural track asks for no problems at all", () => {
    const general = buildQuestionPrompt({ track: "general", role: "Analyst", level: "fresher", plan: planRound("general", "fresher") }).user;
    expect(general).not.toMatch(/type "dsa"/);
    expect(general.match(/type "behavioural"/g)).toHaveLength(3);
  });
});

describe("generateQuestions", () => {
  it("returns one question per slot with the plan's type and topic, whatever the model labelled them", async () => {
    runTask.mockResolvedValueOnce({
      provider: "gemini",
      model: "m",
      text: JSON.stringify({
        questions: [
          { type: "behavioural", topic: "ignored", question: "Given an array…" }, // mislabelled by the model
          { type: "dsa", topic: "graphs", question: "Given a grid…" },
          { type: "cs_fundamentals", question: "What happens on a page fault?" },
          { type: "system_design", question: "Design a URL shortener." },
          { type: "dsa", question: "an extra one the plan did not ask for" },
        ],
      }),
    });
    const { questions } = await generateQuestions({ track: "engineering", role: "x", level: "fresher", random: seq(0, 0, 0) });
    expect(questions.map((q) => q.type)).toEqual(["dsa", "dsa", "cs_fundamentals", "system_design"]);
    expect(questions).toHaveLength(4);
    expect(questions[0].topic).toBe("arrays"); // the plan's draw, not the model's label
    expect(questions[2].topic).toBe("operating systems");
    expect(questions[3].topic).toBeNull();
    expect(questions[3].question).toBe("Design a URL shortener.");
  });

  it("tolerates the old bare-string shape", async () => {
    runTask.mockResolvedValueOnce({ provider: "groq", model: "m", text: JSON.stringify({ questions: ["A?", "B?", "C?"] }) });
    const { questions } = await generateQuestions({ track: "general", role: "x", level: "intern" });
    expect(questions.map((q) => q.question)).toEqual(["A?", "B?", "C?"]);
    expect(questions.every((q) => q.type === "behavioural")).toBe(true);
  });

  it("throws when nothing usable comes back", async () => {
    runTask.mockResolvedValueOnce({ provider: "groq", model: "m", text: '{"questions": [{"type":"dsa"}]}' });
    await expect(generateQuestions({ track: "engineering", role: "x", level: "fresher" })).rejects.toThrow(/no usable questions/);
  });
});

describe("a drilled round", () => {
  const plan = planRound("general", "fresher");

  it("adds the habit's brief, and nothing when there is no focus", () => {
    const drilled = buildQuestionPrompt({ track: "general", role: "x", level: "fresher", plan, focus: "no_number" }).user;
    expect(drilled).toMatch(/This candidate answers without numbers/);
    expect(drilled).toMatch(/ask for scale, cost, duration, complexity or measured outcome/);
    const plain = buildQuestionPrompt({ track: "general", role: "x", level: "fresher", plan }).user;
    expect(plain).not.toMatch(/This candidate/);
  });

  it("has a brief for every flag the extractor can produce", () => {
    for (const flag of ["filler", "restated", "no_number", "rambled"] as const) {
      expect(FOCUS_BRIEF[flag], flag).toMatch(/\S/);
      expect(buildQuestionPrompt({ track: "general", role: "x", level: "fresher", plan, focus: flag }).user).toContain(FOCUS_BRIEF[flag]);
    }
  });

  it("changes how questions are asked, never the plan", () => {
    const drilled = buildQuestionPrompt({ track: "engineering", role: "x", level: "fresher", plan: planRound("engineering", "fresher", seq(0, 0, 0)), focus: "rambled" }).user;
    const slots = drilled.split("\n").filter((l) => /^\d\. type "/.test(l));
    expect(slots.map((l) => l.match(/type "(\w+)"/)![1])).toEqual(["dsa", "dsa", "cs_fundamentals", "system_design"]);
  });
});
