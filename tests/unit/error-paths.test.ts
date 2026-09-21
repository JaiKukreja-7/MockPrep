import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { argsOf, called, fakeSupabase, has, type RecordedOp, type Resolver } from "../support/fake-supabase";
import { AllProvidersFailedError } from "@/lib/llm/index";
import { OUTAGE_MESSAGE } from "@/lib/supabase/outage";

/**
 * The error-state audit, as tests. Each block is one row of the audit that
 * was run by hand first (PROGRESS.md, step 14): what a failure used to
 * produce, and what it must produce now.
 */

let resolver: Resolver = () => ({});
// Every client created during a test — an action and the scoring it calls
// each make their own — so assertions see the whole picture.
const clients: RecordedOp[][] = [];
const allOps = () => clients.flat();
let authResult: { user: { id: string } | null; error?: unknown } = { user: { id: "u1" } };

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const rec = fakeSupabase((op) => resolver(op));
    clients.push(rec.ops);
    return {
      ...rec.client,
      auth: { getUser: async () => ({ data: { user: authResult.user }, error: authResult.error ?? null }) },
    };
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT ${to}`);
  },
}));

const generateQuestions = vi.fn();
const consumeQuota = vi.fn();
const refundQuota = vi.fn();
const scoreAnswer = vi.fn();
const followUp = vi.fn();
const extractFlags = vi.fn();
const analyseResume = vi.fn();
const transcribe = vi.fn();
const interviewerTurn = vi.fn();
vi.mock("@/lib/llm/tasks/generate-questions", () => ({ generateQuestions: (...a: unknown[]) => generateQuestions(...a) }));
vi.mock("@/lib/llm/quota", () => ({
  consumeQuota: (...a: unknown[]) => consumeQuota(...a),
  refundQuota: (...a: unknown[]) => refundQuota(...a),
  QuotaExceededError: class extends Error {},
}));
vi.mock("@/lib/llm/tasks/score-answer", () => ({ scoreRounds: (...a: unknown[]) => scoreAnswer(...a) }));
vi.mock("@/lib/llm/tasks/follow-up", () => ({ followUp: (...a: unknown[]) => followUp(...a) }));
vi.mock("@/lib/llm/tasks/extract-flags", () => ({ extractFlags: (...a: unknown[]) => extractFlags(...a) }));
vi.mock("@/lib/llm/tasks/analyse-resume", () => ({ analyseResume: (...a: unknown[]) => analyseResume(...a) }));
vi.mock("@/lib/llm/tasks/transcribe", () => ({ transcribe: (...a: unknown[]) => transcribe(...a) }));
vi.mock("@/lib/llm/tasks/interviewer-turn", () => ({ interviewerTurn: (...a: unknown[]) => interviewerTurn(...a) }));

const { startRound, submitAnswer, scoreRound } = await import("@/app/rounds/actions");
const { analyseResumeUpload } = await import("@/app/(app)/resume/actions");
const { POST } = await import("@/app/api/voice/turn/route");
const { revalidatePath } = await import("next/cache");

const all429 = (task: string) =>
  new AllProvidersFailedError(task as never, [
    { provider: "groq", model: "openai/gpt-oss-120b", attempt: 0, error: "Groq 429: Rate limit reached" },
    { provider: "groq", model: "openai/gpt-oss-120b", attempt: 1, error: "Groq 429: Rate limit reached" },
    { provider: "openrouter", model: "z-ai/glm-5.2:free", attempt: 0, error: "OpenRouter 429: rate-limited" },
  ]);

const form = (o: Record<string, string | Blob>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};
const outage = { name: "AuthRetryableFetchError", message: "fetch failed", status: 0 };

let consoleError: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  clients.length = 0;
  authResult = { user: { id: "u1" } };
  consumeQuota.mockReset().mockResolvedValue({ allowed: true, used: 1, cap: 60 });
  refundQuota.mockReset().mockResolvedValue(undefined);
  scoreAnswer.mockReset().mockResolvedValue({ overall: 50, structure: 50, specificity: 50, pace: 50, note: "", rounds: [] });
  followUp.mockReset().mockResolvedValue({ probe: null, provider: "x" });
  extractFlags.mockReset().mockResolvedValue({ flags: [], provider: "x" });
  generateQuestions.mockReset().mockResolvedValue({ questions: [{ type: "dsa", topic: "arrays", question: "Q1" }, { type: "dsa", topic: "graphs", question: "Q2" }, { type: "system_design", topic: null, question: "Q3" }] });
  interviewerTurn.mockReset().mockResolvedValue({ text: "Noted." });
  vi.mocked(revalidatePath).mockClear();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => consoleError.mockRestore());

const isTranscriptInsert = (op: RecordedOp) => op.table === "transcripts" && has(op, "insert");
const isRoundsRemaining = (op: RecordedOp) => op.table === "rounds" && has(op, "is");

/* ------------------------------------------------ #1 the duplicate-insert trap */
describe("submitAnswer is idempotent on an answered round", () => {
  const lines = [
    { id: "l0", at_seconds: 0, speaker: "interviewer", body: "Q" },
    { id: "l1", at_seconds: 5, speaker: "candidate", body: "A" },
  ];

  it("writes nothing for a round that already has answered_at, and goes on to score", async () => {
    resolver = (op) => {
      if (op.table === "rounds" && called(op, "select", "id, session_id, answered_at, follow_up, question_type, question"))
        return { data: { id: "r3", session_id: "s1", answered_at: "2026-09-16T00:00:00Z", follow_up: null, question_type: "dsa", question: "Q" } };
      if (isRoundsRemaining(op)) return { count: 0 } as never;
      if (op.table === "transcripts") return { data: lines };
      return {};
    };
    await expect(
      submitAnswer({}, form({ sessionId: "s1", roundId: "r3", question: "Q", answer: "A", elapsed: "90" })),
    ).rejects.toThrow("REDIRECT /report/s1");

    expect(allOps().filter(isTranscriptInsert)).toHaveLength(0);
    expect(allOps().filter((o) => o.table === "rounds" && has(o, "update"))).toHaveLength(0);
    expect(scoreAnswer).toHaveBeenCalledTimes(1);
  });

  it("writes exactly once for an unanswered round", async () => {
    resolver = (op) => {
      if (op.table === "rounds" && called(op, "select", "id, session_id, answered_at, follow_up, question_type, question"))
        return { data: { id: "r1", session_id: "s1", answered_at: null, follow_up: null, question_type: "dsa", question: "Q" } };
      if (isRoundsRemaining(op)) return { count: 2 } as never;
      return {};
    };
    expect(await submitAnswer({}, form({ sessionId: "s1", roundId: "r1", question: "Q", answer: "A", elapsed: "30" }))).toEqual({});
    expect(allOps().filter(isTranscriptInsert)).toHaveLength(1);
    expect(consumeQuota).not.toHaveBeenCalled(); // mid-round answers are not charged
  });

  it("refuses a round that belongs to a different session", async () => {
    resolver = (op) =>
      op.table === "rounds" && called(op, "select", "id, session_id, answered_at, follow_up, question_type, question")
        ? { data: { id: "r1", session_id: "other", answered_at: null, follow_up: null, question_type: "dsa", question: "Q" } }
        : {};
    const out = await submitAnswer({}, form({ sessionId: "s1", roundId: "r1", question: "Q", answer: "A", elapsed: "30" }));
    expect(out.error).toMatch(/not part of this round/);
    expect(allOps().filter(isTranscriptInsert)).toHaveLength(0);
  });
});

/* ------------------------------------------- #2 / #3 the dead ends, and #6 */
describe("the last answer when scoring cannot happen", () => {
  const answered = (op: RecordedOp) =>
    op.table === "rounds" && called(op, "select", "id, session_id, answered_at, follow_up, question_type, question")
      ? { data: { id: "r3", session_id: "s1", answered_at: null, follow_up: null, question_type: "dsa", question: "Q" } }
      : isRoundsRemaining(op)
        ? ({ count: 0 } as never)
        : op.table === "transcripts" && !has(op, "insert")
          ? { data: [{ id: "l0", at_seconds: 0, speaker: "interviewer", body: "Q" }, { id: "l1", at_seconds: 5, speaker: "candidate", body: "A" }] }
          : {};

  it("providers all 429: one sentence, the attempt log in the server log, the session page revalidated", async () => {
    resolver = answered;
    scoreAnswer.mockRejectedValue(all429("answer_scoring"));
    const out = await submitAnswer({}, form({ sessionId: "s1", roundId: "r3", question: "Q", answer: "A", elapsed: "90" }));

    expect(out.error).toBe(
      "Scoring did not go through: every AI provider is rate-limited or down right now. Your answers are saved — score the round again in a minute.",
    );
    expect(out.error).not.toMatch(/groq|openrouter|#\d/);
    expect(out.error!.split("\n")).toHaveLength(1);
    expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/groq\/openai\/gpt-oss-120b #1: Groq 429/));
    expect(revalidatePath).toHaveBeenCalledWith("/session/s1");
  });

  it("cap hit at scoring: the sentence names the cap and the answers are kept", async () => {
    resolver = answered;
    consumeQuota.mockResolvedValue({ allowed: false, used: 60, cap: 60 });
    const out = await submitAnswer({}, form({ sessionId: "s1", roundId: "r3", question: "Q", answer: "A", elapsed: "90" }));
    expect(out.error).toBe("Daily limit reached — 60 of 60 rounds used today.");
    expect(allOps().filter(isTranscriptInsert)).toHaveLength(1);
    expect(revalidatePath).toHaveBeenCalledWith("/session/s1");
  });
});

describe("scoreRound — the way out of the dead end", () => {
  const withSession = (status: string, unanswered: number): Resolver => (op) =>
    op.table === "sessions" && has(op, "select")
      ? { data: { id: "s1", status } }
      : isRoundsRemaining(op)
        ? ({ count: unanswered } as never)
        : op.table === "transcripts" && has(op, "order")
          ? { data: [{ at_seconds: 137 }] }
          : op.table === "transcripts"
            ? { data: [{ id: "l0", at_seconds: 0, speaker: "interviewer", body: "Q" }, { id: "l1", at_seconds: 137, speaker: "candidate", body: "A" }] }
            : {};

  it("scores a live session with every question answered, using the transcript's last timestamp, then goes to the report", async () => {
    resolver = withSession("live", 0);
    await expect(scoreRound({}, form({ sessionId: "s1" }))).rejects.toThrow("REDIRECT /report/s1");
    expect(scoreAnswer).toHaveBeenCalledTimes(1);
    const close = allOps().find((o) => o.table === "sessions" && has(o, "update"));
    expect((argsOf(close!, "update") as [Record<string, unknown>])[0].duration_seconds).toBe(137);
  });

  it("refuses while questions remain", async () => {
    resolver = withSession("live", 1);
    expect((await scoreRound({}, form({ sessionId: "s1" }))).error).toMatch(/still questions to answer/);
    expect(scoreAnswer).not.toHaveBeenCalled();
  });

  it("explains an abandoned round rather than scoring it", async () => {
    resolver = withSession("abandoned", 0);
    expect((await scoreRound({}, form({ sessionId: "s1" }))).error).toMatch(/timed out and cannot be scored/);
  });

  it("sends an already-scored round straight to its report", async () => {
    resolver = withSession("scored", 0);
    await expect(scoreRound({}, form({ sessionId: "s1" }))).rejects.toThrow("REDIRECT /report/s1");
  });

  it("returns the scoring sentence if it fails again, so the button can be pressed again", async () => {
    resolver = withSession("live", 0);
    scoreAnswer.mockRejectedValue(all429("answer_scoring"));
    const out = await scoreRound({}, form({ sessionId: "s1" }));
    expect(out.error).toMatch(/^Scoring did not go through: every AI provider/);
  });
});

/* ----------------------------------------------------- #8 the outage answer */
describe("Supabase unreachable: every action says so, none says 'sign in'", () => {
  beforeEach(() => {
    authResult = { user: null, error: outage };
  });

  it("startRound", async () => {
    expect((await startRound({}, form({ track: "product", role: "PM", mode: "text" }))).error).toBe(OUTAGE_MESSAGE);
  });
  it("submitAnswer", async () => {
    expect((await submitAnswer({}, form({ sessionId: "s1", roundId: "r1", question: "Q", answer: "A", elapsed: "1" }))).error).toBe(OUTAGE_MESSAGE);
  });
  it("scoreRound", async () => {
    expect((await scoreRound({}, form({ sessionId: "s1" }))).error).toBe(OUTAGE_MESSAGE);
  });
  it("analyseResumeUpload", async () => {
    const f = form({ role: "PM" });
    f.set("resume", new File([new Uint8Array(10)], "cv.pdf", { type: "application/pdf" }));
    expect((await analyseResumeUpload({}, f)).error).toBe(OUTAGE_MESSAGE);
  });
  it("the voice route answers 503 with the sentence", async () => {
    const res = await POST(new Request("http://x/api/voice/turn", { method: "POST", body: form({ sessionId: "s1" }) }) as never);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe(OUTAGE_MESSAGE);
  });
  it("a genuine no-session is still a sign-in problem", async () => {
    authResult = { user: null };
    expect((await startRound({}, form({ track: "product", role: "PM", mode: "text" }))).error).toBe("Sign in to start a round.");
  });
});

/* ------------------------------------------------ #6 and #8 starting a round */
describe("startRound when every provider is down", () => {
  beforeEach(() => {
    resolver = (op) => (op.table === "users" ? { data: { is_guest: false } } : {});
  });

  it("returns one sentence that says the round was not charged, refunds it, and logs the attempts", async () => {
    generateQuestions.mockRejectedValue(all429("question_generation"));
    const out = await startRound({}, form({ track: "product", role: "PM", mode: "text" }));
    expect(out.error).toBe(
      "Could not write your questions: every AI provider is rate-limited or down right now. Try again in a minute — you have not been charged a round.",
    );
    expect(out.error!.split("\n")).toHaveLength(1);
    expect(consumeQuota).toHaveBeenCalledWith(1);
    expect(refundQuota).toHaveBeenCalledWith(1);
    expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/Could not write your questions[\s\S]*openrouter\/z-ai\/glm-5.2:free #0/));
  });

  it("refunds when the session or the rounds cannot be written", async () => {
    resolver = (op) =>
      op.table === "users" ? { data: { is_guest: false } } : op.table === "sessions" ? { error: { message: "insert failed" } } : {};
    const out = await startRound({}, form({ track: "product", role: "PM", mode: "text" }));
    expect(out.error).toBe("insert failed");
    expect(refundQuota).toHaveBeenCalledWith(1);
  });

  it("does not refund a round that started", async () => {
    resolver = (op) =>
      op.table === "users" ? { data: { is_guest: false } } : op.table === "sessions" ? { data: { id: "s9" } } : {};
    await expect(startRound({}, form({ track: "product", role: "PM", mode: "text" }))).rejects.toThrow("REDIRECT /session/s9");
    expect(refundQuota).not.toHaveBeenCalled();
  });

  it("does not charge or call a provider when the cap is already hit", async () => {
    consumeQuota.mockResolvedValue({ allowed: false, used: 60, cap: 60 });
    const out = await startRound({}, form({ track: "product", role: "PM", mode: "text" }));
    expect(out.error).toMatch(/^Daily limit reached/);
    expect(generateQuestions).not.toHaveBeenCalled();
    expect(refundQuota).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------- #5a / #5b / #6 the resume */
describe("resume upload", () => {
  const scan = async () =>
    new File([await (await import("node:fs")).promises.readFile("tests/fixtures/scan-no-text.pdf")], "scan.pdf", { type: "application/pdf" });
  const docx = async () =>
    new File([await (await import("node:fs")).promises.readFile("tests/fixtures/resume.docx")], "cv.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
  beforeEach(() => {
    resolver = (op) => (op.table === "users" ? { data: { is_guest: false } } : {});
  });

  it("a file that parses to nothing is refused before the quota is charged", async () => {
    const f = form({ role: "PM" });
    f.set("resume", await scan());
    const out = await analyseResumeUpload({}, f);
    expect(out.error).toMatch(/No text came out of that PDF/);
    expect(consumeQuota).not.toHaveBeenCalled();
  });

  it("an analysis that fails mid-way is one sentence, refunded, and logged", async () => {
    analyseResume.mockRejectedValue(all429("resume_analysis"));
    const f = form({ role: "PM" });
    f.set("resume", await docx());
    const out = await analyseResumeUpload({}, f);
    expect(out.error).toBe(
      "Analysis did not go through: every AI provider is rate-limited or down right now. Try again in a minute — you have not been charged.",
    );
    expect(consumeQuota).toHaveBeenCalledTimes(1);
    expect(refundQuota).toHaveBeenCalledWith(1);
    expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/resume_analysis/));
  });
});

/* ------------------------------------------------- #4b and the voice endings */
describe("voice turn route", () => {
  const turn = () => {
    const f = form({ sessionId: "s1", roundId: "r1", offsetMs: "1000" });
    f.set("audio", new Blob([new Uint8Array(10)], { type: "audio/webm" }), "u.webm");
    return new Request("http://x/api/voice/turn", { method: "POST", body: f }) as never;
  };
  const base: Resolver = (op) =>
    op.table === "users"
      ? { data: { is_guest: false } }
      : op.table === "rounds" && called(op, "select", "id, ordinal, question, session_id, question_type, follow_up, answered_at")
        ? { data: { id: "r1", ordinal: 3, question: "Q", session_id: "s1", question_type: "dsa", follow_up: null, answered_at: null } }
        : op.table === "rounds" && has(op, "is")
          ? { data: [] } // no rounds remaining → this was the last one
          : op.table === "transcripts" && has(op, "insert")
            ? {}
            : op.table === "transcripts"
              ? { data: [{ id: "l0", at_seconds: 0, speaker: "interviewer", body: "Q" }, { id: "l1", at_seconds: 1, speaker: "candidate", body: "hello" }] }
              : op.table.startsWith("rpc:consume_voice_seconds")
                ? { data: [{ allowed: true, granted: 2, used: 2, cap: 600 }] }
                : {};

  it("Whisper failing entirely is a sentence that says the recording is kept, with the blob in the log", async () => {
    resolver = base;
    transcribe.mockRejectedValue(new Error('Groq Whisper 429: {"error":{"message":"Rate limit reached for model whisper-large-v3-turbo"}}'));
    const res = await POST(turn());
    expect(res.status).toBe(502);
    const { error } = await res.json();
    expect(error).toBe("Could not transcribe that. The recording is still here — send it again in a moment.");
    expect(error).not.toMatch(/\{|whisper/);
    expect(consoleError).toHaveBeenCalledWith(expect.stringMatching(/Rate limit reached for model whisper-large-v3-turbo/));
  });

  it("Whisper returning nothing is still the closer-to-the-mic sentence", async () => {
    resolver = base;
    transcribe.mockResolvedValue({ text: "", durationMs: 900 });
    const res = await POST(turn());
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/closer to the mic/);
  });

  it("the last turn with scoring down is a 200 with scoringFailed, so the turn is not retried", async () => {
    resolver = base;
    transcribe.mockResolvedValue({ text: "hello", durationMs: 2000 });
    scoreAnswer.mockRejectedValue(all429("answer_scoring"));
    const res = await POST(turn());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.done).toBe(false);
    expect(body.scoringFailed).toBe(true);
    expect(body.error).toMatch(/^Scoring did not go through/);
    expect(body.lines).toHaveLength(2);
  });
});
