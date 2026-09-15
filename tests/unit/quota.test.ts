import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase, type Resolver } from "../support/fake-supabase";

let resolver: Resolver = () => ({});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => fakeSupabase((op) => resolver(op)).client,
}));

beforeEach(() => vi.resetModules());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const load = () => import("@/lib/llm/quota");

describe("consumeQuota", () => {
  it("passes the cost through and maps the row", async () => {
    let seenArgs: unknown;
    resolver = (op) => {
      seenArgs = op.chain[0][1][0];
      return { data: [{ allowed: true, used: 3, cap: 60 }] };
    };
    const { consumeQuota } = await load();
    expect(await consumeQuota(2)).toEqual({ allowed: true, used: 3, cap: 60 });
    expect(seenArgs).toEqual({ p_cost: 2 });
  });

  it("defaults the cost to 1 and accepts a bare row as well as an array", async () => {
    let seenArgs: unknown;
    resolver = (op) => {
      seenArgs = op.chain[0][1][0];
      return { data: { allowed: false, used: 10, cap: 10 } };
    };
    const { consumeQuota } = await load();
    expect(await consumeQuota()).toEqual({ allowed: false, used: 10, cap: 10 });
    expect(seenArgs).toEqual({ p_cost: 1 });
  });

  it("treats no row at all as not allowed", async () => {
    resolver = () => ({ data: [] });
    const { consumeQuota } = await load();
    expect(await consumeQuota()).toEqual({ allowed: false, used: 0, cap: 0 });
  });

  it("in production, a missing function throws rather than running uncapped", async () => {
    vi.stubEnv("NODE_ENV", "production");
    resolver = () => ({ error: { message: "not found", code: "PGRST202" } });
    const { consumeQuota } = await load();
    await expect(consumeQuota()).rejects.toThrow(/consume_llm_quota is missing.*20260905010000_llm_quota\.sql/);
  });

  it("in development, a missing function warns once and allows", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolver = () => ({ error: { message: "not found", code: "PGRST202" } });
    const { consumeQuota } = await load();
    expect(await consumeQuota()).toEqual({ allowed: true, used: 0, cap: 0 });
    expect(await consumeQuota()).toEqual({ allowed: true, used: 0, cap: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/daily caps are OFF/);
  });

  it("rethrows any other error", async () => {
    resolver = () => ({ error: { message: "permission denied", code: "42501" } });
    const { consumeQuota } = await load();
    await expect(consumeQuota()).rejects.toMatchObject({ code: "42501" });
  });
});

describe("QuotaExceededError", () => {
  it("names the numbers and the reset", async () => {
    const { QuotaExceededError } = await load();
    const err = new QuotaExceededError(60, 60);
    expect(err.name).toBe("QuotaExceededError");
    expect(err.message).toBe("Daily limit reached — 60 of 60 rounds used. It resets at midnight.");
  });
});
