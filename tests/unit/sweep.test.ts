import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { argsOf, called, fakeSupabase, has, type Resolver } from "../support/fake-supabase";

let resolver: Resolver = () => ({});
let recorded: ReturnType<typeof fakeSupabase>;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    recorded = fakeSupabase((op) => resolver(op));
    return recorded.client;
  },
}));

const { sweepIfStale, sweepStaleSessions, STALE_AFTER_MS } = await import("@/lib/rounds/sweep");

const NOW = new Date("2026-09-16T12:00:00Z").getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

function session(overrides: Record<string, unknown>) {
  return { id: "s1", status: "live", started_at: null, created_at: ago(3 * 60 * MIN), ...overrides };
}

describe("sweepIfStale", () => {
  it("the threshold is one hour", () => {
    expect(STALE_AFTER_MS).toBe(60 * 60 * 1000);
  });

  it("ignores a session that does not exist", async () => {
    resolver = () => ({ data: null });
    expect(await sweepIfStale("nope")).toBe(false);
    expect(recorded.ops.some((o) => has(o, "update"))).toBe(false);
  });

  it("ignores a session that is not live", async () => {
    resolver = (op) =>
      op.table === "sessions" ? { data: session({ status: "scored", started_at: ago(5 * 60 * MIN) }) } : { data: null };
    expect(await sweepIfStale("s1")).toBe(false);
    expect(recorded.ops.some((o) => has(o, "update"))).toBe(false);
  });

  it("leaves a live session alone when its last activity is under an hour old", async () => {
    resolver = (op) =>
      op.table === "sessions"
        ? { data: session({ started_at: ago(59 * MIN) }) }
        : { data: null };
    expect(await sweepIfStale("s1")).toBe(false);
    expect(recorded.ops.some((o) => has(o, "update"))).toBe(false);
  });

  it("measures from the newest transcript line, not from when the round started", async () => {
    // Started three hours ago, but someone spoke ten minutes ago: not stale.
    resolver = (op) =>
      op.table === "sessions"
        ? { data: session({ started_at: ago(3 * 60 * MIN) }) }
        : { data: { created_at: ago(10 * MIN) } };
    expect(await sweepIfStale("s1")).toBe(false);
  });

  it("sweeps a live session whose last activity is an hour or more old, guarding on status", async () => {
    resolver = (op) =>
      op.table === "sessions" && called(op, "select", "id, status, started_at, created_at")
        ? { data: session({ started_at: ago(2 * 60 * MIN) }) }
        : op.table === "transcripts"
          ? { data: { created_at: ago(90 * MIN) } }
          : { error: null };

    expect(await sweepIfStale("s1")).toBe(true);

    const update = recorded.ops.find((o) => o.table === "sessions" && called(o, "eq", "status", "live"));
    expect(update).toBeDefined();
    const [patch] = argsOf(update!, "update") as [Record<string, unknown>];
    expect(patch.status).toBe("abandoned");
    expect(patch.ended_at).toBe(new Date(NOW).toISOString());
    expect(called(update!, "eq", "id", "s1")).toBe(true);
  });

  it("uses created_at when a live session never started and has no lines", async () => {
    resolver = (op) =>
      op.table === "sessions" && called(op, "select", "id, status, started_at, created_at")
        ? { data: session({ started_at: null, created_at: ago(61 * MIN) }) }
        : { data: null };
    expect(await sweepIfStale("s1")).toBe(true);
  });

  it("reports false if the update itself fails", async () => {
    resolver = (op) =>
      has(op, "update")
        ? { error: { message: "nope" } }
        : op.table === "sessions"
          ? { data: session({ started_at: ago(2 * 60 * MIN) }) }
          : { data: null };
    expect(await sweepIfStale("s1")).toBe(false);
  });
});

describe("sweepStaleSessions", () => {
  it("returns 0 with nothing live", async () => {
    resolver = () => ({ data: [] });
    expect(await sweepStaleSessions()).toBe(0);
  });

  it("sweeps only the stale ones, using the newest line per session from one query", async () => {
    const live = [
      { id: "stale", started_at: ago(3 * 60 * MIN), created_at: ago(3 * 60 * MIN) },
      { id: "fresh", started_at: ago(3 * 60 * MIN), created_at: ago(3 * 60 * MIN) },
      { id: "quiet", started_at: null, created_at: ago(2 * 60 * MIN) },
    ];
    // Lines arrive newest first, as the query orders them; the first per
    // session is the one that counts.
    const lines = [
      { session_id: "fresh", created_at: ago(5 * MIN) },
      { session_id: "fresh", created_at: ago(120 * MIN) },
      { session_id: "stale", created_at: ago(70 * MIN) },
    ];
    resolver = (op) =>
      op.table === "sessions" && called(op, "eq", "status", "live") && !has(op, "update")
        ? { data: live }
        : op.table === "transcripts"
          ? { data: lines }
          : { error: null };

    expect(await sweepStaleSessions()).toBe(2);

    const update = recorded.ops.find((o) => has(o, "update"));
    expect(argsOf(update!, "in")).toEqual(["id", ["stale", "quiet"]]);
    expect(called(update!, "eq", "status", "live")).toBe(true);

    const lineQuery = recorded.ops.find((o) => o.table === "transcripts");
    expect(argsOf(lineQuery!, "in")).toEqual(["session_id", ["stale", "fresh", "quiet"]]);
  });

  it("returns 0 when everything live is fresh, without issuing an update", async () => {
    resolver = (op) =>
      op.table === "sessions"
        ? { data: [{ id: "a", started_at: ago(10 * MIN), created_at: ago(10 * MIN) }] }
        : { data: [] };
    expect(await sweepStaleSessions()).toBe(0);
    expect(recorded.ops.some((o) => has(o, "update"))).toBe(false);
  });
});
