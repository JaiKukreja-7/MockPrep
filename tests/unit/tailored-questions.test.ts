import { describe, expect, it, vi } from "vitest";

/**
 * The tailored round: the extra slots, the prompt's tailoring block, the
 * model's type on a tailored slot, and the redaction of what comes back.
 * Only runTask is mocked; the route it is asked for is asserted too.
 */

const runTask = vi.fn();
vi.mock("@/lib/llm/index", () => ({ runTask: (...a: unknown[]) => runTask(...a) }));

const { buildQuestionPrompt, planTailoredRound, tailoredSources, TRACK_TYPES } = await import(
  "@/lib/llm/tasks/generate-questions"
);
const { generateTailoredQuestions } = await import("@/lib/llm/tasks/tailored-questions");

const seq = (...values: number[]) => {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
};

const RESUME =
  "Priya Sharma — priya@example.com — +61 400 000 000 — github.com/priya/x\n" +
  "Built a Kafka ingestion pipeline in Go handling 20k events/s at Acme. Cut p99 latency 40%.";
const JOB = {
  title: "Backend engineer",
  company: "Beta",
  description: "Requirements: Go, PostgreSQL, Kubernetes, on-call for a payments service.",
};

describe("tailoredSources", () => {
  it("one extra per input, and the gap question only with both", () => {
    expect(tailoredSources({ resumeText: RESUME })).toEqual(["resume"]);
    expect(tailoredSources({ job: JOB })).toEqual(["job"]);
    expect(tailoredSources({ resumeText: RESUME, job: JOB })).toEqual(["resume", "gap"]);
    expect(tailoredSources({})).toEqual([]);
    expect(tailoredSources({ resumeText: "  ", job: { title: "", company: "", description: "" } })).toEqual([]);
  });
});

describe("planTailoredRound", () => {
  it("stays four long: with both inputs, one DSA becomes the resume probe and system design the gap", () => {
    const plan = planTailoredRound("engineering", "fresher", { resumeText: RESUME, job: JOB }, seq(0, 0, 0));
    expect(plan).toHaveLength(4);
    expect(plan.map((s) => s.source)).toEqual([null, "resume", null, "gap"]);
    expect(plan[0]).toMatchObject({ type: "dsa", topic: "arrays" });
    expect(plan[2].type).toBe("cs_fundamentals");
  });

  it("with only a resume, one DSA goes and system design stays", () => {
    const plan = planTailoredRound("engineering", "fresher", { resumeText: RESUME }, seq(0, 0, 0));
    expect(plan.map((s) => [s.type, s.source])).toEqual([
      ["dsa", null],
      ["cs_fundamentals", "resume"],
      ["cs_fundamentals", null],
      ["system_design", null],
    ]);
  });

  it("with only a job, the last slot becomes the job question", () => {
    const plan = planTailoredRound("consulting", "junior", { job: JOB });
    expect(plan.map((s) => [s.type, s.source])).toEqual([
      ["case", null],
      ["case", null],
      ["case", "job"],
    ]);
  });
});

describe("the tailored prompt", () => {
  const plan = planTailoredRound("engineering", "fresher", { resumeText: RESUME, job: JOB }, seq(0, 0, 0));
  const { user } = buildQuestionPrompt({ track: "engineering", role: "Backend engineer", level: "fresher", plan, tailoring: { resumeText: RESUME, job: JOB } });

  it("carries the job and the resume, verbatim, before the slots", () => {
    expect(user).toMatch(/THE JOB:\nTitle: Backend engineer\nCompany: Beta\nDescription:\nRequirements: Go/);
    expect(user).toMatch(/THE RESUME:\nPriya Sharma/);
    expect(user.indexOf("THE RESUME:")).toBeLessThan(user.indexOf("The questions, in order:"));
  });

  it("steers the plan's own slots to the job's stack and keeps DSA general", () => {
    expect(user).toMatch(/Ground the fundamentals and design questions in the stack and the responsibilities the job names/);
    expect(user).toMatch(/DSA problems stay general/);
    expect(user).toMatch(/Never quote a phone number, email address or URL from the resume/);
  });

  it("describes each tailored slot by its source and lets the model pick a type from the track's", () => {
    const lines = user.split("\n").filter((l) => /^\d\. type/.test(l));
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^1\. type "dsa" on arrays/);
    expect(lines[1]).toMatch(/^2\. type one of "cs_fundamentals", "system_design", "behavioural", "dsa": written to the RESUME/);
    expect(lines[3]).toMatch(/^4\. type one of .*: a GAP question: a requirement in the job description that the resume does not evidence/);
  });

  it("with only a job there is no resume block and no gap slot", () => {
    const jobOnly = buildQuestionPrompt({
      track: "engineering",
      role: "x",
      level: "fresher",
      plan: planTailoredRound("engineering", "fresher", { job: JOB }, seq(0, 0, 0)),
      tailoring: { job: JOB },
    }).user;
    expect(jobOnly).not.toMatch(/THE RESUME/);
    expect(jobOnly).not.toMatch(/GAP question/);
    expect(jobOnly).toMatch(/^4\. type one of .*: written to the JOB/m);
  });

  it("an untailored prompt is unchanged", () => {
    const { user: plain } = buildQuestionPrompt({ track: "engineering", role: "x", level: "fresher", plan: planTailoredRound("engineering", "fresher", {}, seq(0, 0, 0)) });
    expect(plain).not.toMatch(/tailored|THE JOB|THE RESUME/);
  });
});

describe("generateTailoredQuestions", () => {
  const reply = (questions: unknown[]) =>
    runTask.mockResolvedValueOnce({ provider: "groq", model: "m", text: JSON.stringify({ questions }) });

  it("runs the sensitive task, not question_generation", async () => {
    reply([{ type: "dsa", question: "Q1" }]);
    await generateTailoredQuestions({ track: "engineering", role: "x", level: "fresher", tailoring: { resumeText: RESUME } });
    expect(runTask.mock.calls[0][0]).toBe("tailored_question_generation");
  });

  it("takes the model's type on a tailored slot when it is one of the track's, else falls back", async () => {
    reply([
      { type: "dsa", question: "Q1" },
      { type: "system_design", topic: "Kafka pipeline", question: "Walk me through the Kafka pipeline you built at Acme." },
      { type: "cs_fundamentals", question: "Q3" },
      { type: "case", topic: "Kubernetes", question: "The role needs Kubernetes; the resume does not show it. How would you approach it?" },
    ]);
    const { questions } = await generateTailoredQuestions({
      track: "engineering",
      role: "x",
      level: "fresher",
      tailoring: { resumeText: RESUME, job: JOB },
      random: seq(0, 0, 0),
    });
    expect(questions).toHaveLength(4);
    expect(questions[1]).toMatchObject({ type: "system_design", topic: "Kafka pipeline", source: "resume" });
    // "case" is not an engineering type: the slot's default stands.
    expect(questions[3]).toMatchObject({ type: TRACK_TYPES.engineering[0], topic: "Kubernetes", source: "gap" });
    expect(questions[0].source).toBeNull();
    expect(questions[2].source).toBeNull();
  });

  it("the plan's type still wins on the plan's own slots", async () => {
    reply([{ type: "behavioural", question: "Given an array…" }]);
    const { questions } = await generateTailoredQuestions({ track: "engineering", role: "x", level: "fresher", tailoring: { job: JOB } });
    expect(questions[0].type).toBe("dsa");
  });

  it("redacts contact details the model quoted off the resume, in the question and the topic", async () => {
    reply([
      { type: "dsa", question: "Q1" },
      {
        type: "behavioural",
        topic: "github.com/priya/x",
        question: "Your resume lists priya@example.com and +61 400 000 000 — tell me about the pipeline at github.com/priya/x and what broke",
      },
    ]);
    const { questions } = await generateTailoredQuestions({ track: "engineering", role: "x", level: "fresher", tailoring: { resumeText: RESUME }, random: seq(0, 0, 0) });
    expect(questions[1].question).toBe("Your resume lists [email] and [phone] — tell me about the pipeline at [url] and what broke");
    expect(questions[1].topic).toBe("[url]");
  });
});
