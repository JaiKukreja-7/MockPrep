import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderError, type LLMProvider, type ProviderId } from "@/lib/llm/types";

/**
 * The chain under test is the real one: runTask → withBackoff → provider.
 * Only the providers are fakes, scripted to fail in particular ways, and the
 * clock is faked so the 1/2/4/8s ladder can be measured rather than waited.
 */

type Script = Array<() => Promise<{ text: string }>>;

const calls: Record<string, number> = {};
const scripts: Partial<Record<ProviderId, Script>> = {};

function scripted(id: ProviderId, policy: LLMProvider["dataPolicy"] = "private"): LLMProvider {
  return {
    id,
    label: id,
    dataPolicy: policy,
    isConfigured: () => true,
    complete: async () => {
      calls[id] = (calls[id] ?? 0) + 1;
      const step = scripts[id]?.shift();
      if (!step) throw new Error(`${id}: no scripted response left`);
      const { text } = await step();
      return { text, provider: id, model: "m" };
    },
  };
}

const providers: Record<ProviderId, LLMProvider> = {
  gemini: scripted("gemini"),
  groq: scripted("groq"),
  openrouter: scripted("openrouter", "trains-on-free-tier"),
};

vi.mock("@/lib/llm/registry", () => ({
  getProvider: (id: ProviderId) => providers[id],
  allProviders: () => Object.values(providers),
}));

const { runTask } = await import("@/lib/llm/index");

const fail = (status: number, retryable: boolean, retryAfterMs?: number) => async () => {
  throw new ProviderError(`${status}`, "groq", status, retryable, retryAfterMs);
};
const ok = (text: string) => async () => ({ text });

beforeEach(() => {
  vi.useFakeTimers();
  for (const k of Object.keys(calls)) delete calls[k];
  for (const k of Object.keys(scripts)) delete scripts[k as ProviderId];
});
afterEach(() => vi.useRealTimers());

/** Drives a promise while advancing fake time; records how long it slept. */
async function settle<T>(p: Promise<T>): Promise<{ value: T; sleptMs: number }> {
  let sleptMs = 0;
  let done = false;
  let value!: T;
  let error: unknown;
  p.then((v) => { value = v; done = true; }, (e) => { error = e; done = true; });
  // Each loop: let microtasks run, then jump to the next timer if still pending.
  for (let i = 0; i < 100 && !done; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
    if (done) break;
    const before = vi.getTimerCount();
    if (before === 0) {
      await Promise.resolve();
      continue;
    }
    const now = Date.now();
    await vi.advanceTimersToNextTimerAsync();
    sleptMs += Date.now() - now;
  }
  if (!done) throw new Error("promise never settled");
  if (error !== undefined) throw error;
  return { value, sleptMs };
}

describe("provider failover", () => {
  it("on repeated 429s walks the full 1/2/4/8s ladder on the first provider, then moves to the next", async () => {
    // answer_scoring: groq then openrouter.
    scripts.groq = [fail(429, true), fail(429, true), fail(429, true), fail(429, true), fail(429, true)];
    scripts.openrouter = [ok('{"score":1}')];

    const { value, sleptMs } = await settle(runTask("answer_scoring", { system: "", user: "" }));

    expect(value.provider).toBe("openrouter");
    expect(calls.groq).toBe(5); // one try plus four retries
    expect(calls.openrouter).toBe(1);
    expect(sleptMs).toBe(1000 + 2000 + 4000 + 8000);
    expect(value.attempts.filter((a) => a.provider === "groq")).toHaveLength(5);
  });

  it("honours a longer Retry-After over its own step", async () => {
    scripts.groq = [fail(429, true, 5000), ok("fine")];
    const { value, sleptMs } = await settle(runTask("answer_scoring", { system: "", user: "" }));
    expect(value.provider).toBe("groq");
    expect(sleptMs).toBe(5000); // max(1000, 5000)
  });

  it("on a 401 fails over immediately without burning the ladder", async () => {
    scripts.groq = [fail(401, false)];
    scripts.openrouter = [ok("fine")];

    const { value, sleptMs } = await settle(runTask("answer_scoring", { system: "", user: "" }));

    expect(value.provider).toBe("openrouter");
    expect(calls.groq).toBe(1);
    expect(sleptMs).toBe(0);
    expect(value.attempts).toEqual([
      { provider: "groq", model: "openai/gpt-oss-120b", attempt: 0, error: "401" },
    ]);
  });

  it("treats an empty-content 200 as retryable: the same provider is retried, then answers", async () => {
    scripts.groq = [
      async () => { throw new ProviderError("Groq returned no content (finish_reason: length)", "groq", undefined, true); },
      ok('{"score":2}'),
    ];
    const { value, sleptMs } = await settle(runTask("answer_scoring", { system: "", user: "" }));
    expect(value.provider).toBe("groq");
    expect(calls.groq).toBe(2);
    expect(sleptMs).toBe(1000);
  });

  it("skips an unconfigured provider without an attempt and reports it", async () => {
    providers.groq.isConfigured = () => false;
    scripts.openrouter = [ok("fine")];
    try {
      const { value } = await settle(runTask("answer_scoring", { system: "", user: "" }));
      expect(calls.groq).toBeUndefined();
      expect(value.attempts[0]).toEqual({
        provider: "groq",
        model: "openai/gpt-oss-120b",
        attempt: 0,
        error: "no API key configured",
      });
    } finally {
      providers.groq.isConfigured = () => true;
    }
  });

  it("throws AllProvidersFailedError naming every attempt when the chain is exhausted", async () => {
    scripts.groq = [fail(401, false)];
    scripts.openrouter = [fail(403, false)];
    await expect(settle(runTask("answer_scoring", { system: "", user: "" }))).rejects.toThrow(
      /Every provider for "answer_scoring" failed:\n\s+groq\/openai\/gpt-oss-120b #0: 401\n\s+openrouter\/z-ai\/glm-5.2:free #0: 403/,
    );
  });
});
