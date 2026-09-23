import { beforeEach, describe, expect, it, vi } from "vitest";
import { argsOf, called, fakeSupabase, has, type Resolver } from "../support/fake-supabase";

let resolver: Resolver = () => ({});
let recorded: ReturnType<typeof fakeSupabase>;
const consumeQuota = vi.fn();
const scoreRounds = vi.fn();
const extractFlags = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    recorded = fakeSupabase((op) => resolver(op));
    return recorded.client;
  },
}));
vi.mock("@/lib/llm/quota", () => ({
  consumeQuota: (...a: unknown[]) => consumeQuota(...a),
  QuotaExceededError: class extends Error {},
}));
vi.mock("@/lib/llm/tasks/score-answer", () => ({ scoreRounds: (...a: unknown[]) => scoreRounds(...a) }));
vi.mock("@/lib/llm/tasks/extract-flags", () => ({ extractFlags: (...a: unknown[]) => extractFlags(...a) }));

const { scoreSession } = await import("@/lib/rounds/score");

const lines = [
  { id: "l0", round_id: "r1", at_seconds: 0, speaker: "interviewer", body: "Tell me about a time…" },
  { id: "l1", round_id: "r1", at_seconds: 20, speaker: "candidate", body: "So, um, I guess…" },
  { id: "l2", round_id: "r2", at_seconds: 40, speaker: "interviewer", body: "And the result?" },
  { id: "l3", round_id: "r2", at_seconds: 45, speaker: "candidate", body: "It went well." },
];
const roundRows = [
  { id: "r1", ordinal: 1, question: "Tell me about a time…", question_type: "behavioural", topic: null, follow_up: null },
  { id: "r2", ordinal: 2, question: "And the result?", question_type: "dsa", topic: "arrays", follow_up: null },
];

beforeEach(() => {
  consumeQuota.mockReset().mockResolvedValue({ allowed: true, used: 1, cap: 60 });
  scoreRounds.mockReset().mockResolvedValue({
    overall: 55, structure: 55, specificity: 60, pace: 50, note: "",
    rounds: [
      { ordinal: 1, score: 40, detail: { situation: 40, action: 40, result: 40 }, modelAnswer: "I'd name the project, say what I did, and land a number." },
      { ordinal: 2, score: 70, detail: { approach: 90, complexity: 60, edge_cases: 60 }, modelAnswer: null },
    ],
  });
  extractFlags.mockReset().mockResolvedValue({ flags: [], provider: "groq/m" });
  resolver = (op) =>
    op.table === "transcripts" && has(op, "select")
      ? { data: lines }
      : op.table === "rounds" && has(op, "select")
        ? { data: roundRows }
        : op.table === "sessions" && has(op, "select")
          ? { data: { level: "junior" } }
          : {};
});

describe("scoreSession", () => {
  it("stops at the cap without reading the transcript", async () => {
    consumeQuota.mockResolvedValue({ allowed: false, used: 60, cap: 60 });
    const out = await scoreSession("s1", 90);
    expect(out).toEqual({ ok: false, error: "Daily limit reached — 60 of 60 rounds used today." });
    expect(recorded.ops).toHaveLength(0);
    expect(scoreRounds).not.toHaveBeenCalled();
  });

  it("charges exactly one request per scoring", async () => {
    await scoreSession("s1", 90);
    expect(consumeQuota).toHaveBeenCalledWith(1);
  });

  it("has nothing to score for an empty transcript", async () => {
    resolver = () => ({ data: [] });
    expect(await scoreSession("s1", 90)).toEqual({ ok: false, error: "Nothing to score yet." });
    expect(scoreRounds).not.toHaveBeenCalled();
  });

  it("scores each round under its type, writes the four numbers and the per-round scores, maps flag indexes back to row ids, and closes the session", async () => {
    extractFlags.mockResolvedValue({ flags: [{ index: 1, flag: "filler" }, { index: 3, flag: "no_number" }], provider: "groq/m" });

    expect(await scoreSession("s1", 137)).toEqual({ ok: true });

    // The scorer saw each round with its type and its own candidate answer.
    const [toScore] = scoreRounds.mock.calls[0] as [Array<Record<string, unknown>>];
    expect(toScore).toEqual([
      { ordinal: 1, type: "behavioural", level: "junior", topic: null, question: "Tell me about a time…", answer: "So, um, I guess…", followUp: null, followUpAnswer: null },
      { ordinal: 2, type: "dsa", level: "junior", topic: "arrays", question: "And the result?", answer: "It went well.", followUp: null, followUpAnswer: null },
    ]);
    // …and each round got its score, rubric detail and model answer written
    // back in one statement — a report never shows one without the other.
    const roundUpdates = recorded.ops.filter((o) => o.table === "rounds" && has(o, "update"));
    expect(roundUpdates.map((o) => [argsOf(o, "update")![0], argsOf(o, "eq")])).toEqual([
      [
        {
          score: 40,
          score_detail: { situation: 40, action: 40, result: 40 },
          model_answer: "I'd name the project, say what I did, and land a number.",
        },
        ["id", "r1"],
      ],
      // A round the model gave no usable answer for stores null, not a gap.
      [{ score: 70, score_detail: { approach: 90, complexity: 60, edge_cases: 60 }, model_answer: null }, ["id", "r2"]],
    ]);
    // …and the flag extractor saw the same lines, indexed from 0.
    expect(extractFlags.mock.calls[0][0]).toEqual(lines.map((l, index) => ({ index, speaker: l.speaker, body: l.body })));

    const upsert = recorded.ops.find((o) => o.table === "scores");
    expect(argsOf(upsert!, "upsert")).toEqual([
      { session_id: "s1", overall: 55, structure: 55, specificity: 60, pace: 50 },
    ]);

    // Index 1 → row l1, index 3 → row l3. Not the index itself.
    const flagUpdates = recorded.ops.filter((o) => o.table === "transcripts" && called(o, "update", { flag: "filler" }) || (o.table === "transcripts" && called(o, "update", { flag: "no_number" })));
    expect(flagUpdates.map((o) => argsOf(o, "eq"))).toEqual([["id", "l1"], ["id", "l3"]]);

    // The first sessions op is the level read; the close is the update.
    const close = recorded.ops.find((o) => o.table === "sessions" && has(o, "update"));
    const [patch] = argsOf(close!, "update") as [Record<string, unknown>];
    expect(patch.status).toBe("scored");
    expect(patch.duration_seconds).toBe(137);
    expect(typeof patch.ended_at).toBe("string");
    expect(called(close!, "eq", "id", "s1")).toBe(true);
  });

  it("reports a model failure as one sentence without writing a score", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    scoreRounds.mockRejectedValue(new Error("Every provider for \"answer_scoring\" failed"));
    expect(await scoreSession("s1", 90)).toEqual({
      ok: false,
      error: "Scoring did not go through. Your answers are saved — score the round again in a minute.",
    });
    warn.mockRestore();
    expect(recorded.ops.some((o) => o.table === "scores")).toBe(false);
    // The level read is a select; nothing is written to the session.
    expect(recorded.ops.some((o) => o.table === "sessions" && has(o, "update"))).toBe(false);
  });
});
