import { describe, expect, it, vi } from "vitest";

const runTask = vi.fn();
vi.mock("@/lib/llm/index", () => ({ runTask: (...a: unknown[]) => runTask(...a) }));

const { buildScoringPrompt, scoreRounds, sanitiseModelAnswer, MAX_MODEL_ANSWER_CHARS, RUBRIC } = await import(
  "@/lib/llm/tasks/score-answer"
);

const rounds = [
  { ordinal: 1, type: "dsa" as const, level: "fresher" as const, topic: "two pointers", question: "Two-sum?", answer: "Hash map, O(n).", followUp: "What if the input is empty?", followUpAnswer: "Return an empty list." },
  { ordinal: 2, type: "system_design" as const, level: "fresher" as const, topic: null, question: "Design a URL shortener.", answer: "A database and a hash.", followUp: null, followUpAnswer: null },
  { ordinal: 3, type: "behavioural" as const, level: "fresher" as const, topic: null, question: "Tell me about a conflict.", answer: "It went well.", followUp: null, followUpAnswer: null },
];

describe("the scoring prompt", () => {
  const { user } = buildScoringPrompt(rounds);

  it("keeps the round-level delivery axes", () => {
    expect(user).toMatch(/structure — does each answer open with a claim/);
    expect(user).toMatch(/specificity — named things, numbers/);
    expect(user).toMatch(/pace — the right length/);
  });

  it("judges a DSA answer on approach, complexity and edge cases — not on shape", () => {
    expect(user).toMatch(/### Question 1 — type dsa \(two pointers\)/);
    expect(user).toMatch(/approach — is there a correct, codeable method/);
    expect(user).toMatch(/complexity — did they state time and space/);
    expect(user).toMatch(/edge_cases — empty input, one element, duplicates/);
  });

  it("gives every type its own rubric and asks for exactly those axes back", () => {
    expect(user).toMatch(/type system_design/);
    expect(user).toMatch(/tradeoffs — did they choose between options/);
    expect(user).toMatch(/\{"ordinal": 1, "detail": \{"approach": 0, "complexity": 0, "edge_cases": 0\}, "model_answer": "\.\.\."\}/);
    expect(user).toMatch(/\{"ordinal": 2, "detail": \{"requirements": 0, "tradeoffs": 0, "scalability": 0\}, "model_answer": "\.\.\."\}/);
    expect(user).toMatch(/\{"ordinal": 3, "detail": \{"situation": 0, "action": 0, "result": 0\}, "model_answer": "\.\.\."\}/);
  });

  it("includes the follow-up exchange where one happened, and only there", () => {
    expect(user).toMatch(/Follow-up: What if the input is empty\?\nA: Return an empty list\./);
    expect(user.match(/Follow-up:/g)).toHaveLength(1);
  });
});

describe("scoreRounds", () => {
  it("derives every number: round score is the rubric mean, overall is the delivery mean", async () => {
    runTask.mockResolvedValueOnce({
      provider: "groq",
      model: "m",
      text: JSON.stringify({
        structure: 60, specificity: 70, pace: 50, note: "Say the complexity unprompted.",
        rounds: [
          { ordinal: 1, detail: { approach: 90, complexity: 60, edge_cases: 30 }, model_answer: "I'd use two pointers from both ends, O(n) time and O(1) space, and I'd handle fewer than two elements and duplicates." },
          { ordinal: 2, detail: { requirements: 40, tradeoffs: 20, scalability: 30, overall: 99 } }, // an invented axis is ignored
          // ordinal 3 missing entirely
          { ordinal: 9, detail: { approach: 100 } }, // hallucinated round
        ],
      }),
    });
    const out = await scoreRounds(rounds);
    expect(out.overall).toBe(60);
    expect(out.note).toBe("Say the complexity unprompted.");
    expect(out.rounds).toEqual([
      { ordinal: 1, score: 60, detail: { approach: 90, complexity: 60, edge_cases: 30 }, modelAnswer: "I'd use two pointers from both ends, O(n) time and O(1) space, and I'd handle fewer than two elements and duplicates." },
      { ordinal: 2, score: 30, detail: { requirements: 40, tradeoffs: 20, scalability: 30 }, modelAnswer: null },
      { ordinal: 3, score: 0, detail: { situation: 0, action: 0, result: 0 }, modelAnswer: null },
    ]);
  });

  it("clamps and coerces axis values", async () => {
    runTask.mockResolvedValueOnce({
      provider: "groq", model: "m",
      text: JSON.stringify({ structure: "80", specificity: 120, pace: -5, rounds: [{ ordinal: 1, detail: { approach: "75", complexity: 150, edge_cases: "nope" } }] }),
    });
    const out = await scoreRounds([rounds[0]]);
    expect([out.structure, out.specificity, out.pace]).toEqual([80, 100, 0]);
    expect(out.rounds[0].detail).toEqual({ approach: 75, complexity: 100, edge_cases: 0 });
  });

  it("every type has a three-axis rubric", () => {
    for (const axes of Object.values(RUBRIC)) expect(axes).toHaveLength(3);
  });
});

describe("the model-answer instruction", () => {
  const { user } = buildScoringPrompt(rounds);

  it("asks for one per question, in the first person, as part of the same call", () => {
    expect(user).toMatch(/For each question also write model_answer: what a strong answer from this candidate would have sounded like, in the first person/);
  });

  it("names only the axes of the types actually asked, and each type once", () => {
    expect(user).toMatch(/ {2}dsa: approach, complexity, edge_cases/);
    expect(user).toMatch(/ {2}system_design: requirements, tradeoffs, scalability/);
    expect(user).toMatch(/ {2}behavioural: situation, action, result/);
    // Not a type this round asked.
    expect(user).not.toMatch(/product_sense: /);
    // Two DSA rounds must not list the DSA axes twice.
    const twoDsa = buildScoringPrompt([rounds[0], { ...rounds[0], ordinal: 2 }]).user;
    expect(twoDsa.match(/ {2}dsa: approach/g)).toHaveLength(1);
  });

  it("pitches at the level and builds on what they said, including their own specifics", () => {
    expect(user).toMatch(/asked at the "fresher" level/);
    expect(user).toMatch(/Pitch it at their level\. A stronger answer, not a senior engineer's\./);
    expect(user).toMatch(/keep what was right, and make the part they missed the part that stands out/);
    expect(user).toMatch(/a project, a claim, something on their resume — use the specifics they gave rather than inventing a different project/);
  });

  it("caps the length and bans preamble and markdown", () => {
    expect(user).toMatch(new RegExp(`Under ${MAX_MODEL_ANSWER_CHARS} characters`));
    expect(user).toMatch(/No preamble, no "a strong answer would", no markdown/);
  });

  it("can be left out, and then nothing asks for one", () => {
    const without = buildScoringPrompt(rounds, false).user;
    expect(without).not.toMatch(/model_answer/);
    expect(without).toMatch(/\{"ordinal": 1, "detail": \{"approach": 0, "complexity": 0, "edge_cases": 0\}\}/);
  });
});

describe("sanitiseModelAnswer", () => {
  const long = "A sentence that says something useful. ".repeat(40);

  it.each([
    [null, null],
    [undefined, null],
    [42, null],
    ["", null],
    ["  ", null],
    ["Too short.", null],
  ])("%j → %j", (input, expected) => {
    expect(sanitiseModelAnswer(input)).toBe(expected);
  });

  it("keeps an answer that fits, trimmed", () => {
    const a = "  I'd use two pointers from both ends: O(n) time, O(1) space, and I'd handle the empty case.  ";
    expect(sanitiseModelAnswer(a)).toBe(a.trim());
  });

  it("strips a markdown fence the model added anyway", () => {
    expect(sanitiseModelAnswer("```\nI'd use two pointers, O(n) time and O(1) space, handling duplicates.\n```")).toBe(
      "I'd use two pointers, O(n) time and O(1) space, handling duplicates.",
    );
  });

  it("cuts an over-long answer at the last sentence that fits, never mid-word", () => {
    const out = sanitiseModelAnswer(long)!;
    expect(out.length).toBeLessThanOrEqual(MAX_MODEL_ANSWER_CHARS);
    expect(out.endsWith(".")).toBe(true);
    expect(long.startsWith(out)).toBe(true);
  });
});
