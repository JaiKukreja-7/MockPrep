import { beforeEach, describe, expect, it, vi } from "vitest";
import { argsOf, called, fakeSupabase, type Resolver } from "../support/fake-supabase";

let resolver: Resolver = () => ({});
let recorded: ReturnType<typeof fakeSupabase>;
const consumeQuota = vi.fn();
const scoreAnswer = vi.fn();
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
vi.mock("@/lib/llm/tasks/score-answer", () => ({ scoreAnswer: (...a: unknown[]) => scoreAnswer(...a) }));
vi.mock("@/lib/llm/tasks/extract-flags", () => ({ extractFlags: (...a: unknown[]) => extractFlags(...a) }));

const { scoreSession } = await import("@/lib/rounds/score");

const lines = [
  { id: "l0", at_seconds: 0, speaker: "interviewer", body: "Tell me about a time…" },
  { id: "l1", at_seconds: 20, speaker: "candidate", body: "So, um, I guess…" },
  { id: "l2", at_seconds: 40, speaker: "interviewer", body: "And the result?" },
  { id: "l3", at_seconds: 45, speaker: "candidate", body: "It went well." },
];

beforeEach(() => {
  consumeQuota.mockReset().mockResolvedValue({ allowed: true, used: 1, cap: 60 });
  scoreAnswer.mockReset().mockResolvedValue({ overall: 55, structure: 55, specificity: 60, pace: 50 });
  extractFlags.mockReset().mockResolvedValue({ flags: [], provider: "groq/m" });
  resolver = (op) => (op.table === "transcripts" && called(op, "select", "id, at_seconds, speaker, body") ? { data: lines } : {});
});

describe("scoreSession", () => {
  it("stops at the cap without reading the transcript", async () => {
    consumeQuota.mockResolvedValue({ allowed: false, used: 60, cap: 60 });
    const out = await scoreSession("s1", 90);
    expect(out).toEqual({ ok: false, error: "Daily limit reached — 60 of 60 rounds used today." });
    expect(recorded.ops).toHaveLength(0);
    expect(scoreAnswer).not.toHaveBeenCalled();
  });

  it("charges exactly one request per scoring", async () => {
    await scoreSession("s1", 90);
    expect(consumeQuota).toHaveBeenCalledWith(1);
  });

  it("has nothing to score for an empty transcript", async () => {
    resolver = () => ({ data: [] });
    expect(await scoreSession("s1", 90)).toEqual({ ok: false, error: "Nothing to score yet." });
    expect(scoreAnswer).not.toHaveBeenCalled();
  });

  it("scores the whole exchange, writes the four numbers, maps flag indexes back to row ids, and closes the session", async () => {
    extractFlags.mockResolvedValue({ flags: [{ index: 1, flag: "filler" }, { index: 3, flag: "no_number" }], provider: "groq/m" });

    expect(await scoreSession("s1", 137)).toEqual({ ok: true });

    // The model saw Q/A-labelled lines in order, as one round.
    const [{ answer }] = scoreAnswer.mock.calls[0] as [{ question: string; answer: string }];
    expect(answer).toBe("Q: Tell me about a time…\n\nA: So, um, I guess…\n\nQ: And the result?\n\nA: It went well.");
    // …and the flag extractor saw the same lines, indexed from 0.
    expect(extractFlags.mock.calls[0][0]).toEqual(lines.map((l, index) => ({ index, speaker: l.speaker, body: l.body })));

    const upsert = recorded.ops.find((o) => o.table === "scores");
    expect(argsOf(upsert!, "upsert")).toEqual([
      { session_id: "s1", overall: 55, structure: 55, specificity: 60, pace: 50 },
    ]);

    // Index 1 → row l1, index 3 → row l3. Not the index itself.
    const flagUpdates = recorded.ops.filter((o) => o.table === "transcripts" && called(o, "update", { flag: "filler" }) || (o.table === "transcripts" && called(o, "update", { flag: "no_number" })));
    expect(flagUpdates.map((o) => argsOf(o, "eq"))).toEqual([["id", "l1"], ["id", "l3"]]);

    const close = recorded.ops.find((o) => o.table === "sessions");
    const [patch] = argsOf(close!, "update") as [Record<string, unknown>];
    expect(patch.status).toBe("scored");
    expect(patch.duration_seconds).toBe(137);
    expect(typeof patch.ended_at).toBe("string");
    expect(called(close!, "eq", "id", "s1")).toBe(true);
  });

  it("reports a model failure as one sentence without writing a score", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    scoreAnswer.mockRejectedValue(new Error("Every provider for \"answer_scoring\" failed"));
    expect(await scoreSession("s1", 90)).toEqual({
      ok: false,
      error: "Scoring did not go through. Your answers are saved — score the round again in a minute.",
    });
    warn.mockRestore();
    expect(recorded.ops.some((o) => o.table === "scores")).toBe(false);
    expect(recorded.ops.some((o) => o.table === "sessions")).toBe(false);
  });
});
