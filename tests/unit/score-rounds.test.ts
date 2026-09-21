import { describe, expect, it, vi } from "vitest";

const runTask = vi.fn();
vi.mock("@/lib/llm/index", () => ({ runTask: (...a: unknown[]) => runTask(...a) }));

const { buildScoringPrompt, scoreRounds, RUBRIC } = await import("@/lib/llm/tasks/score-answer");

const rounds = [
  { ordinal: 1, type: "dsa" as const, topic: "two pointers", question: "Two-sum?", answer: "Hash map, O(n).", followUp: "What if the input is empty?", followUpAnswer: "Return an empty list." },
  { ordinal: 2, type: "system_design" as const, topic: null, question: "Design a URL shortener.", answer: "A database and a hash.", followUp: null, followUpAnswer: null },
  { ordinal: 3, type: "behavioural" as const, topic: null, question: "Tell me about a conflict.", answer: "It went well.", followUp: null, followUpAnswer: null },
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
    expect(user).toMatch(/\{"ordinal": 1, "detail": \{"approach": 0, "complexity": 0, "edge_cases": 0\}\}/);
    expect(user).toMatch(/\{"ordinal": 2, "detail": \{"requirements": 0, "tradeoffs": 0, "scalability": 0\}\}/);
    expect(user).toMatch(/\{"ordinal": 3, "detail": \{"situation": 0, "action": 0, "result": 0\}\}/);
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
          { ordinal: 1, detail: { approach: 90, complexity: 60, edge_cases: 30 } },
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
      { ordinal: 1, score: 60, detail: { approach: 90, complexity: 60, edge_cases: 30 } },
      { ordinal: 2, score: 30, detail: { requirements: 40, tradeoffs: 20, scalability: 30 } },
      { ordinal: 3, score: 0, detail: { situation: 0, action: 0, result: 0 } },
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
