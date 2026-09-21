import { beforeEach, describe, expect, it, vi } from "vitest";
import { argsOf, called, fakeSupabase, has, type RecordedOp, type Resolver } from "../support/fake-supabase";

/**
 * The follow-up cap: at most one probing question per round, in both the
 * text and the voice loop, tested through the real action and route with
 * the follow-up task mocked. The prompt and the sanitiser are tested in
 * follow-up.test.ts against the real module.
 */

let resolver: Resolver = () => ({});
const clients: RecordedOp[][] = [];
const allOps = () => clients.flat();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const rec = fakeSupabase((op) => resolver(op));
    clients.push(rec.ops);
    return { ...rec.client, auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }) } };
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT ${to}`); } }));
const followUpTask = vi.fn();
vi.mock("@/lib/llm/tasks/follow-up", () => ({ followUp: (...a: unknown[]) => followUpTask(...a) }));
vi.mock("@/lib/llm/quota", () => ({ consumeQuota: async () => ({ allowed: true, used: 1, cap: 60 }), refundQuota: async () => {}, QuotaExceededError: class extends Error {} }));
vi.mock("@/lib/rounds/score", () => ({ scoreSession: async () => ({ ok: true }) }));
const transcribe = vi.fn();
vi.mock("@/lib/llm/tasks/transcribe", () => ({ transcribe: (...a: unknown[]) => transcribe(...a) }));
vi.mock("@/lib/llm/tasks/interviewer-turn", () => ({ interviewerTurn: async () => ({ text: "Noted." }) }));

const { submitAnswer } = await import("@/app/rounds/actions");
const { POST } = await import("@/app/api/voice/turn/route");

const form = (o: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(o)) f.set(k, v); return f; };
const QUESTION = "Given an array, find two numbers that sum to a target. Walk me through your approach and its complexity.";
const PROBE = "What is the time complexity of that?";

const roundRow = (followUp: string | null) => ({
  id: "r1", session_id: "s1", answered_at: null, follow_up: followUp, question_type: "dsa", question: QUESTION,
});
const textResolver = (followUpStored: string | null): Resolver => (op) =>
  op.table === "rounds" && called(op, "select", "id, session_id, answered_at, follow_up, question_type, question")
    ? { data: roundRow(followUpStored) }
    : op.table === "sessions"
      ? { data: { level: "fresher" } }
      : op.table === "rounds" && has(op, "is")
        ? ({ count: 2 } as never)
        : {};
const roundUpdates = () => allOps().filter((o) => o.table === "rounds" && has(o, "update")).map((o) => argsOf(o, "update")![0] as Record<string, unknown>);

beforeEach(() => {
  clients.length = 0;
  followUpTask.mockReset().mockResolvedValue({ probe: PROBE, provider: "x" });
});

describe("the follow-up cap — text round", () => {
  it("first answer, weak: the probe is stored on the round and the round is NOT answered", async () => {
    resolver = textResolver(null);
    const out = await submitAnswer({}, form({ sessionId: "s1", roundId: "r1", question: QUESTION, answer: "I would use a loop.", elapsed: "30" }));
    expect(out).toEqual({});
    expect(followUpTask).toHaveBeenCalledTimes(1);
    expect(followUpTask.mock.calls[0][0]).toMatchObject({ type: "dsa", level: "fresher", question: QUESTION, answer: "I would use a loop." });
    expect(roundUpdates()).toEqual([{ follow_up: PROBE }]);
  });

  it("first answer, solid: no probe, the round is answered", async () => {
    resolver = textResolver(null);
    followUpTask.mockResolvedValue({ probe: null, provider: "x" });
    await submitAnswer({}, form({ sessionId: "s1", roundId: "r1", question: QUESTION, answer: "Hash map, one pass, O(n) time O(n) space; empty input returns nothing.", elapsed: "30" }));
    expect(followUpTask).toHaveBeenCalledTimes(1);
    expect(roundUpdates()).toEqual([expect.objectContaining({ answered_at: expect.any(String) })]);
  });

  it("the answer to the probe: the task is NOT asked again, the round is answered — one per question", async () => {
    resolver = textResolver(PROBE);
    await submitAnswer({}, form({ sessionId: "s1", roundId: "r1", question: PROBE, answer: "Still vague, honestly.", elapsed: "60" }));
    expect(followUpTask).not.toHaveBeenCalled();
    const updates = roundUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0]).toHaveProperty("answered_at");
    expect(updates[0]).not.toHaveProperty("follow_up");
    // The probe is the interviewer's transcript line for this exchange.
    const insert = allOps().find((o) => o.table === "transcripts" && has(o, "insert"));
    expect((argsOf(insert!, "insert")![0] as Array<{ speaker: string; body: string }>)[0]).toMatchObject({ speaker: "interviewer", body: PROBE });
  });

  it("a stale retry of the first answer while the probe is pending writes nothing", async () => {
    resolver = textResolver(PROBE);
    const out = await submitAnswer({}, form({ sessionId: "s1", roundId: "r1", question: QUESTION, answer: "I would use a loop.", elapsed: "31" }));
    expect(out).toEqual({});
    expect(allOps().some((o) => o.table === "transcripts" && has(o, "insert"))).toBe(false);
    expect(followUpTask).not.toHaveBeenCalled();
  });

  it("a follow-up brain failure never loses the round: the round is answered as if no probe", async () => {
    resolver = textResolver(null);
    followUpTask.mockRejectedValue(new Error("Every provider for \"follow_up\" failed"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await submitAnswer({}, form({ sessionId: "s1", roundId: "r1", question: QUESTION, answer: "loop", elapsed: "30" }));
    expect(roundUpdates()).toEqual([expect.objectContaining({ answered_at: expect.any(String) })]);
    err.mockRestore();
  });
});

describe("the follow-up cap — voice round", () => {
  const turn = () => {
    const f = form({ sessionId: "s1", roundId: "r1", offsetMs: "1000" });
    f.set("audio", new Blob([new Uint8Array(10)], { type: "audio/webm" }), "u.webm");
    return new Request("http://x/api/voice/turn", { method: "POST", body: f }) as never;
  };
  const voiceResolver = (followUpStored: string | null): Resolver => (op) =>
    op.table === "users"
      ? { data: { is_guest: false } }
      : op.table === "rounds" && called(op, "select", "id, ordinal, question, session_id, question_type, follow_up, answered_at")
        ? { data: { id: "r1", ordinal: 1, question: QUESTION, session_id: "s1", question_type: "dsa", follow_up: followUpStored, answered_at: null } }
        : op.table === "sessions"
          ? { data: { level: "junior" } }
          : op.table === "rounds" && has(op, "is")
            ? { data: [{ id: "r2", ordinal: 2, question: "Next?" }] }
            : op.table === "transcripts" && has(op, "insert")
              ? {}
              : op.table === "transcripts"
                ? { data: [] }
                : op.table.startsWith("rpc:")
                  ? { data: [{ allowed: true, granted: 2, used: 2, cap: 600 }] }
                  : {};

  beforeEach(() => transcribe.mockReset().mockResolvedValue({ text: "I would use a loop.", durationMs: 2000 }));

  it("first answer, weak: the probe comes back as the next question, flagged, with no bridge line, and the round is not advanced", async () => {
    resolver = voiceResolver(null);
    const res = await POST(turn());
    const body = await res.json();
    expect(body).toMatchObject({ nextQuestion: PROBE, followUp: true, acknowledgement: null, done: false });
    expect(followUpTask.mock.calls[0][0]).toMatchObject({ level: "junior", type: "dsa" });
    expect(roundUpdates()).toEqual([{ follow_up: PROBE }]);
  });

  it("the answer to the probe: not asked again, the round is answered, the real next question follows", async () => {
    resolver = voiceResolver(PROBE);
    const res = await POST(turn());
    const body = await res.json();
    expect(followUpTask).not.toHaveBeenCalled();
    expect(body.followUp).toBeUndefined();
    expect(body.nextQuestion).toBe("Next?");
    expect(roundUpdates()).toEqual([expect.objectContaining({ answered_at: expect.any(String) })]);
    // The transcript's interviewer line for this turn is the probe, verbatim.
    const insert = allOps().find((o) => o.table === "transcripts" && has(o, "insert"));
    expect((argsOf(insert!, "insert")![0] as Array<{ body: string }>)[0].body).toBe(PROBE);
  });
});
