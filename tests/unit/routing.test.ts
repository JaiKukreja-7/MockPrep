import { afterEach, describe, expect, it, vi } from "vitest";
import type { LLMProvider, ProviderId } from "@/lib/llm/types";

/**
 * The route table is validated when lib/llm/routing.ts is imported, so the
 * only way to test the validator is to import the module with a poisoned
 * registry and watch the import itself. `vi.resetModules()` between cases
 * gives each one a fresh import.
 */

function fakeProvider(id: ProviderId, dataPolicy: LLMProvider["dataPolicy"]): LLMProvider {
  return {
    id,
    label: id,
    dataPolicy,
    isConfigured: () => true,
    complete: async () => ({ text: "", provider: id, model: "" }),
  };
}

function registryWith(policies: Record<ProviderId, LLMProvider["dataPolicy"]>) {
  const providers = Object.fromEntries(
    (Object.keys(policies) as ProviderId[]).map((id) => [id, fakeProvider(id, policies[id])]),
  ) as Record<ProviderId, LLMProvider>;
  return {
    getProvider: (id: ProviderId) => providers[id],
    allProviders: () => Object.values(providers),
  };
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("@/lib/llm/registry");
});

describe("routing table data-policy assertion", () => {
  it("accepts the real table when every sensitive task routes only to private providers", async () => {
    vi.doMock("@/lib/llm/registry", () =>
      registryWith({ gemini: "private", groq: "private", openrouter: "trains-on-free-tier" }),
    );
    const routing = await import("@/lib/llm/routing");
    expect(routing.TASKS.resume_analysis.sensitive).toBe(true);
    expect(routing.TASKS.resume_analysis.chain.map((s) => s.provider)).toEqual(["groq"]);
    // Tailored questions see the resume too, and are a task of their own so
    // question_generation's Gemini lead can never be handed one.
    expect(routing.TASKS.tailored_question_generation.sensitive).toBe(true);
    expect(routing.TASKS.tailored_question_generation.chain.map((s) => s.provider)).toEqual(["groq"]);
  });

  it("every task that can see a resume is marked sensitive", async () => {
    vi.doMock("@/lib/llm/registry", () =>
      registryWith({ gemini: "private", groq: "private", openrouter: "trains-on-free-tier" }),
    );
    const routing = await import("@/lib/llm/routing");
    for (const task of ["resume_analysis", "tailored_question_generation"] as const) {
      expect(routing.TASKS[task].sensitive, task).toBe(true);
    }
  });

  it("throws at import, naming the task and the provider, if a sensitive task's provider trains on content", async () => {
    // Same table; the provider it trusts has changed its policy underneath it.
    vi.doMock("@/lib/llm/registry", () =>
      registryWith({ gemini: "private", groq: "trains-on-free-tier", openrouter: "trains-on-free-tier" }),
    );
    await expect(import("@/lib/llm/routing")).rejects.toThrow(
      /task "resume_analysis" is marked sensitive but routes to "groq"/,
    );
  });

  it("does not care about non-sensitive tasks routing to training-eligible providers", async () => {
    vi.doMock("@/lib/llm/registry", () =>
      registryWith({ gemini: "trains-on-free-tier", groq: "private", openrouter: "trains-on-free-tier" }),
    );
    // question_generation routes to gemini; that is allowed because it is not sensitive.
    await expect(import("@/lib/llm/routing")).resolves.toBeDefined();
  });

  it("runTask drops a training-eligible step from a sensitive chain even if the table were bypassed", async () => {
    vi.doMock("@/lib/llm/registry", () =>
      registryWith({ gemini: "private", groq: "private", openrouter: "trains-on-free-tier" }),
    );
    const { runTask } = await import("@/lib/llm/index");
    const { TASKS } = await import("@/lib/llm/routing");
    // Assemble the unsafe chain at runtime, after the import-time check
    // passed, with the bad step FIRST so it would answer if it were used.
    TASKS.resume_analysis.chain.unshift({ provider: "openrouter", model: "x" });
    const result = await runTask("resume_analysis", { system: "", user: "" });
    expect(result.provider).toBe("groq");
    expect(result.attempts.some((a) => a.provider === "openrouter")).toBe(false);
  });

  it("refuses outright when a sensitive chain has no private provider left", async () => {
    vi.doMock("@/lib/llm/registry", () =>
      registryWith({ gemini: "trains-on-free-tier", groq: "trains-on-free-tier", openrouter: "trains-on-free-tier" }),
    );
    // The table itself is now unsafe, so importing it throws first — which is
    // the point: this state cannot be reached at runtime.
    await expect(import("@/lib/llm/routing")).rejects.toThrow(/marked sensitive but routes to/);
  });
});

describe("a call raised to sensitive at runtime (a resume-tailored round)", () => {
  const privateRegistry = () =>
    registryWith({ gemini: "trains-on-free-tier", groq: "private", openrouter: "trains-on-free-tier" });

  it("normally uses the whole chain, training-eligible leads included", async () => {
    vi.doMock("@/lib/llm/registry", () => privateRegistry());
    const { runTask } = await import("@/lib/llm/index");
    // interviewer_turn leads with gemini, which trains on the free tier.
    const result = await runTask("interviewer_turn", { system: "", user: "" });
    expect(result.provider).toBe("gemini");
  });

  it("drops every training-eligible step when the call says sensitive", async () => {
    vi.doMock("@/lib/llm/registry", () => privateRegistry());
    const { runTask } = await import("@/lib/llm/index");
    for (const task of ["interviewer_turn", "answer_scoring", "flag_extraction", "follow_up"] as const) {
      const result = await runTask(task, { system: "", user: "", sensitive: true });
      expect(result.provider, task).toBe("groq");
      expect(result.attempts.some((a) => a.provider !== "groq"), task).toBe(false);
    }
  });

  it("every task keeps a private leg, so any call can be raised", async () => {
    vi.doMock("@/lib/llm/registry", () => privateRegistry());
    const { TASKS } = await import("@/lib/llm/routing");
    const { getProvider } = await import("@/lib/llm/registry");
    for (const [task, config] of Object.entries(TASKS)) {
      expect(
        config.chain.some((s) => getProvider(s.provider).dataPolicy === "private"),
        task,
      ).toBe(true);
    }
  });

  it("throws rather than sending when raising would empty the chain", async () => {
    // A table that is safe at import (no task marked sensitive routes badly)
    // but has a task with no private leg at all.
    vi.doMock("@/lib/llm/registry", () =>
      registryWith({ gemini: "trains-on-free-tier", groq: "private", openrouter: "trains-on-free-tier" }),
    );
    const { runTask } = await import("@/lib/llm/index");
    const { TASKS } = await import("@/lib/llm/routing");
    TASKS.interviewer_turn.chain = [{ provider: "gemini", model: "x" }];
    await expect(runTask("interviewer_turn", { system: "", user: "", sensitive: true })).rejects.toThrow(
      /no provider in its chain has a private data policy/,
    );
  });
});
